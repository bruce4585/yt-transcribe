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

    // ---- 2) 用 RapidAPI 获取 MP3 直链 ----
    const rapidKey = process.env.RAPIDAPI_KEY;
    const rapidHost = process.env.RAPIDAPI_HOST; // 例：youtube-mp36.p.rapidapi.com
    if (!rapidKey || !rapidHost) {
      return res.status(500).json({ error: 'Missing RAPIDAPI_KEY or RAPIDAPI_HOST' });
    }

    const mp3Resp = await fetch(`https://${rapidHost}/dl?id=${encodeURIComponent(videoId)}`, {
      headers: {
        'X-RapidAPI-Key': rapidKey,
        'X-RapidAPI-Host': rapidHost,
      },
    });

    if (!mp3Resp.ok) {
      const t = await mp3Resp.text();
      return res.status(502).json({ error: 'RapidAPI failed', detail: t });
    }
    const mp3Data = await mp3Resp.json();
    const audioUrl = mp3Data?.link || mp3Data?.url;
    if (!audioUrl) return res.status(502).json({ error: 'No audio link returned by RapidAPI', data: mp3Data });

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
