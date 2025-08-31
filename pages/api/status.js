// pages/api/status.js
// 作用：查询 AssemblyAI 转写任务状态，完成时返回 text（和 srt）

export default async function handler(req, res) {
  try {
    const id = typeof req.query.id === 'string' ? req.query.id : null;
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const aaiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!aaiKey) return res.status(500).json({ error: 'Missing ASSEMBLYAI_API_KEY' });

    // 1) 查询状态
    const statusResp = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { Authorization: aaiKey },
      cache: 'no-store',
    });
    const status = await statusResp.json();
    if (!statusResp.ok) {
      return res.status(502).json({ error: 'AssemblyAI status failed', detail: status });
    }

    // 2) 若完成，顺便取 SRT（如果你只要 TXT，可以不取）
    let srt = '';
    if (status.status === 'completed') {
      const srtResp = await fetch(`https://api.assemblyai.com/v2/transcript/${id}/srt`, {
        headers: { Authorization: aaiKey },
      });
      srt = await srtResp.text().catch(() => '');
    }

    return res.status(200).json({
      status: status.status,     // queued | processing | completed | error
      text: status.text || '',
      srt,
      error: status.error || null,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
