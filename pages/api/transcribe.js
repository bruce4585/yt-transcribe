// pages/api/transcribe.js

function extractYoutubeId(input) {
  try {
    const m1 = input.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
    if (m1) return m1[1];
    const m2 = input.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/);
    if (m2) return m2[1];
    const url = new URL(input);
    const v = url.searchParams.get('v');
    if (v) return v;
    return null;
  } catch {
    return null;
  }
}

async function fetchMp3LinkWithPolling({ videoId, rapidKey, rapidHost, maxTries = 25, intervalMs = 3000 }) {
  const endpoint = `https://${rapidHost}/dl?id=${encodeURIComponent(videoId)}`;
  for (let i = 0; i < maxTries; i++) {
    const r = await fetch(endpoint, {
      headers: {
        'X-RapidAPI-Key': rapidKey,
        'X-RapidAPI-Host': rapidHost,
      },
      cache: 'no-store',
    });
    const data = await r.json().catch(() => ({}));
    const link = data?.link || data?.url;
    if (link) return { ok: true, link, title: data?.title || '' };

    if (data?.status === 'processing' || data?.msg === 'in queue') {
      await new Promise((res) => setTimeout(res, intervalMs));
      continue;
    }
    return { ok: false, error: 'RapidAPI response', data };
  }
  return { ok: false, error: 'Timed out waiting for RapidAPI to generate MP3 link' };
}

// ✅ 关键：把远程 mp3 先上传到 AssemblyAI，返回 upload_url
async function uploadToAssemblyAI({ aaiKey, audioUrl }) {
  // 尝试拉取远程 mp3（跟随重定向）
  const audioResp = await fetch(audioUrl, {
    headers: {
      // 某些源需要 UA 才返回
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
    },
    redirect: 'follow',
  });
  if (!audioResp.ok || !audioResp.body) {
    const t = await audioResp.text().catch(() => '');
    throw new Error(`Fetch audio failed: ${audioResp.status} ${t}`);
  }

  // 直接把流转发到 AssemblyAI /upload
  // （Node 18+/Vercel 默认 fetch 支持可读流透传）
  const uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: {
      Authorization: aaiKey,
      'Content-Type': 'application/octet-stream',
    },
    body: audioResp.body, // 流式上传，避免整段读入内存
  });

  if (!uploadResp.ok) {
    const errText = await uploadResp.text().catch(() => '');
    throw new Error(`AssemblyAI upload failed: ${uploadResp.status} ${errText}`);
  }

  const uploadData = await uploadResp.json();
  if (!uploadData?.upload_url) throw new Error('No upload_url from AssemblyAI');
  return uploadData.upload_url;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { url, language = 'zh' } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });

    const videoId = extractYoutubeId(url);
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

    const rapidKey = process.env.RAPIDAPI_KEY;
    const rapidHost = process.env.RAPIDAPI_HOST;
    if (!rapidKey || !rapidHost) {
      return res.status(500).json({ error: 'Missing RAPIDAPI_KEY or RAPIDAPI_HOST' });
    }

    // 1) 轮询拿 mp3 直链
    const mp3 = await fetchMp3LinkWithPolling({ videoId, rapidKey, rapidHost });
    if (!mp3.ok) {
      return res.status(502).json({ error: 'No audio link returned by RapidAPI', data: mp3 });
    }
    const audioUrl = mp3.link;

    // 2) 先把音频上传到 AssemblyAI，拿到 upload_url
    const aaiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!aaiKey) return res.status(500).json({ error: 'Missing ASSEMBLYAI_API_KEY' });

    const uploadUrl = await uploadToAssemblyAI({ aaiKey, audioUrl });

    // 3) 再用 upload_url 创建转写任务
    const createResp = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        Authorization: aaiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: uploadUrl,
        language_code: language === 'zh' ? 'zh' : 'en',
        punctuate: true,
        format_text: true,
      }),
    });

    const createData = await createResp.json();
    if (!createResp.ok) {
      return res.status(502).json({ error: 'AssemblyAI create failed', detail: createData });
    }

    return res.status(200).json({ id: createData.id });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
