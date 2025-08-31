// pages/api/transcribe.js
// 作用：根据 YouTube 链接创建 AssemblyAI 转写任务，返回 { id }

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { url, language = 'zh' } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });

    // ---- 1) 从 YouTube 链接提取视频 ID ----
    const m = url.match(/[?&]v=([^&]+)|youtu\.be\/([^?]+)/);
    const videoId = m ? (m[1] || m[2]) : null;
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

// ---- 工具：从各种形式的 YouTube 链接里提取视频 ID（含 shorts/youtu.be）----
function extractYoutubeId(input) {
  try {
    // 短链接 youtu.be/XXXX
    const m1 = input.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
    if (m1) return m1[1];

    // shorts/XXXX
    const m2 = input.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/);
    if (m2) return m2[1];

    // 正常链接 ?v=XXXX 或 &v=XXXX
    const url = new URL(input);
    const v = url.searchParams.get('v');
    if (v) return v;

    return null;
  } catch {
    return null;
  }
}

// ---- 轮询 RapidAPI 直到返回可用的 MP3 链接 ----
async function fetchMp3LinkWithPolling({ videoId, rapidKey, rapidHost, maxTries = 20, intervalMs = 3000 }) {
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

    // 常见字段：status: "ok"/"processing"， link: "...", msg: "in queue"
    const link = data?.link || data?.url;

    if (link) return { ok: true, link, title: data?.title || '' };

    // 仍在排队或处理中 -> 等待后重试
    if (data?.status === 'processing' || data?.msg === 'in queue') {
      await new Promise((res) => setTimeout(res, intervalMs));
      continue;
    }

    // 其它错误（例如版权/地区/直播）直接返回
    return { ok: false, error: 'RapidAPI response', data };
  }

  return { ok: false, error: 'Timed out waiting for RapidAPI to generate MP3 link' };
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

    // ✅ 这里使用轮询拿到 MP3 直链
    const mp3 = await fetchMp3LinkWithPolling({ videoId, rapidKey, rapidHost, maxTries: 25, intervalMs: 3000 });
    if (!mp3.ok) {
      return res.status(502).json({ error: 'No audio link returned by RapidAPI', data: mp3 });
    }
    const audioUrl = mp3.link;

    // ↓↓↓ 以下保持你原来 AssemblyAI 创建任务的逻辑不变 ↓↓↓
    const aaiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!aaiKey) return res.status(500).json({ error: 'Missing ASSEMBLYAI_API_KEY' });

    const createResp = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        Authorization: aaiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: audioUrl,
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

    // ---- 3) 创建 AssemblyAI 转写任务（几秒返回一个 id）----
    const aaiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!aaiKey) return res.status(500).json({ error: 'Missing ASSEMBLYAI_API_KEY' });

    const createResp = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        Authorization: aaiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: audioUrl,
        language_code: language === 'zh' ? 'zh' : 'en',
        punctuate: true,
        format_text: true,
      }),
    });

    const createData = await createResp.json();
    if (!createResp.ok) {
      return res.status(502).json({ error: 'AssemblyAI create failed', detail: createData });
    }

    // 返回 transcript id，前端据此去轮询 /api/status?id=...
    return res.status(200).json({ id: createData.id });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
