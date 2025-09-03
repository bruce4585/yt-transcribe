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
      redirect: 'follow',
    });

    // ✅ 只读取一次响应体
    const raw = await r.text().catch(() => '');
    console.log('[RapidAPI][raw]', i, 'status =', r.status, 'body =', raw?.slice(0, 500));

    // 再尝试解析 JSON（解析失败则保持 data = {}）
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }

    // 兼容不同字段名
    const link =
      data?.link ||
      data?.url ||
      data?.dlink ||
      data?.data?.link ||
      data?.data?.url;

    if (link) {
      console.log('[RapidAPI][choose link]', link);
      return { ok: true, link, title: data?.title || data?.data?.title || '' };
    }

    // 排队中的常见返回
    const status = (data && (data.status || data.msg || data.message || '') + '') .toLowerCase();
    if (status.includes('processing') || status.includes('queue')) {
      await new Promise((res) => setTimeout(res, intervalMs));
      continue;
    }

    // 其它异常情况
    return { ok: false, error: 'RapidAPI response', data };
  }

  return { ok: false, error: 'Timed out waiting for RapidAPI to generate MP3 link' };
}

// --- 新增：把远程 mp3 整段抓到 Buffer ---
async function fetchMp3ToBuffer(audioUrl) {
  // 某些源必须带 UA，且需要跟随重定向
  const resp = await fetch(audioUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
      // 有些源需要 Referer，先不写，如果还不行再加：
      // 'Referer': 'https://www.youtube.com/'
    },
    redirect: 'follow',
    cache: 'no-store',
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Fetch audio failed: ${resp.status} ${t?.slice(0, 200)}`);
  }

  // 直接把整段读进来（注意内存占用）
  const arr = await resp.arrayBuffer();
  return Buffer.from(arr);
}

// --- 新实现：用 Buffer 上传到 AssemblyAI /upload ---
async function uploadToAssemblyAI({ aaiKey, audioUrl }) {
  console.log('[UPLOAD] start download mp3 =>', audioUrl);

  // 这里可以做几次重试，防止短时过期或 5xx
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const buf = await fetchMp3ToBuffer(audioUrl);

      console.log('[UPLOAD] mp3 size =', buf.length, 'bytes');

      const uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: {
          Authorization: aaiKey,
          'Content-Type': 'application/octet-stream',
        },
        body: buf, // 把字节直接发给 AssemblyAI
      });

      if (!uploadResp.ok) {
        const errText = await uploadResp.text().catch(() => '');
        throw new Error(`AssemblyAI upload failed: ${uploadResp.status} ${errText?.slice(0, 200)}`);
      }

      const uploadData = await uploadResp.json();
      if (!uploadData?.upload_url) throw new Error('No upload_url from AssemblyAI');

      console.log('[UPLOAD] got upload_url =', uploadData.upload_url);
      return uploadData.upload_url;
    } catch (e) {
      lastErr = e;
      console.log('[UPLOAD][retry]', i + 1, 'error =', e?.message);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr || new Error('Upload failed');
}

export default async function handler(req, res) {
  console.log('[TRANSCRIBE] req.method =', req.method, 'body =', req.body);
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
