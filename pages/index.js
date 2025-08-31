export default function Home() {
  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>🎥 YouTube 转文稿 App</h1>
      <p>输入 YouTube 链接，获取音频并生成文字稿。</p>

      <form method="POST" action="/api/transcribe">
        <input
          type="text"
          name="url"
          placeholder="粘贴 YouTube 链接..."
          style={{ width: "300px", padding: "8px" }}
        />
        <button type="submit" style={{ marginLeft: "10px", padding: "8px 16px" }}>
          转换
        </button>
      </form>
    </div>
  )
}
