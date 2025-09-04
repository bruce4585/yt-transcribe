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

// ====== 多供应商 RapidAPI 拉取 MP3 链接（自动容错+轮询） ======
async function fetchMp3LinkWithFallback({ videoId, rapidKey }) {
  // 这里列出可用的供应商。第一个是你当前使用的；其余两个是占位示例，等会教你怎么从
  // RapidAPI 控制台抄 “host / path / 参数名” 填进来。
  const providers = [
    // 1) 你现在的
    { host: process.env.RAPIDAPI_HOST || 'youtube-mp36.p.rapidapi.com', path: '/dl', query: 'id' },

    // 2) 示例：换一个提供商（把 xxx 换成控制台里的 host/path/参数名）
    // { host: 'youtube-mp3-download1.p.rapidapi.com', path: '/dl', query: 'id' },

    // 3) 示例：再换一个（把 xxx 换成控制台里的 host/path/参数名）
    // { host: 'ytstream-download-youtube-videos.p.rapidapi.com', path: '/dl', query: 'id' },
  ];

  // 通用的解析函数：尽最大可能从 JSON 里找出直链
  const pickLink = (obj) => {
    if (!obj || typeof obj !== 'object') return '';
    return (
      obj.link || obj.url || obj.audio || obj.mp3 || obj.file ||
      obj?.data?.link || obj?.data?.url || ''
    );
  };

  // 轮询等待的尝试次数/间隔
  const maxTries = 25;
  const intervalMs = 3000;

  // 依次尝试不同供应商；每个供应商内部再轮询（等待其生成链接）
  for (const prov of providers) {
    const endpoint = `https://${prov.host}${prov.path}?${prov.query}=${encodeURIComponent(videoId)}`;
    console.log('[RapidAPI][try]', prov.host, endpoint);

    for (let i = 0; i < maxTries; i++) {
      // 拉一次
      const r = await fetch(endpoint, {
        headers: {
          'X-RapidAPI-Key': rapidKey,
          'X-RapidAPI-Host': prov.host,
        },
        cache: 'no-store',
        redirect: 'follow',
      });

      // 先看返回的 content-type，避免拿到 HTML 页面
      const ctype = r.headers.get('content-type') || '';
      console.log('[RapidAPI][headers]', Object.fromEntries(r.headers.entries()));

      // 优先 JSON
      if (ctype.includes('application/json')) {
        const data = await r.json().catch(() => ({}));
        const link = pickLink(data);
        console.log('[RapidAPI][json]', prov.host, 'status =', r.status, 'link =', link);

        if (link) return { ok: true, link, title: data?.title || '' };

        // 常见排队/生成中的状态字段
        if (data?.status === 'processing' || data?.msg === 'in queue') {
          await new Promise((res) => setTimeout(res, intervalMs));
          continue; // 继续轮询这个供应商
        }

        // 不是可等待的状态，换下一个供应商
        break;
      }

      // 如果不是 JSON（多数是 text/html），读一小段原文帮你排错
      const raw = await r.text().catch(() => '');
      console.log('[RapidAPI][raw][full]', prov.host, 'status =', r.status, 'body =', raw.slice(0, 500));

      // HTML 基本没救，直接换下一个供应商
      break;
    }

    console.log('[RapidAPI]', prov.host, 'no link, try next provider...');
  }

  return { ok: false, error: 'No usable MP3 link from all RapidAPI providers' };
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
    // 新写法（只保留 RAPIDAPI_KEY；不再需要 rapidHost）
    const rapidKey = process.env.RAPIDAPI_KEY;
    if (!rapidKey) {
      return res.status(500).json({ error: 'Missing RAPIDAPI_KEY' });
    }
    
    // 1) 取 mp3 直链（新函数名 fetchMp3LinkWithFallback，内置自动换供应商）
    const mp3 = await fetchMp3LinkWithFallback({ videoId, rapidKey });
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
