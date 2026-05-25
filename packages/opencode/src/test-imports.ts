console.log('Testing dynamic imports in compiled binary...')
try {
  const t = await import('@tavily/core')
  console.log('tavily ok:', Object.keys(t))
} catch (e) {
  console.error('tavily fail:', e.message)
}
try {
  const f = await import('@mendable/firecrawl-js')
  console.log('firecrawl ok:', Object.keys(f))
} catch (e) {
  console.error('firecrawl fail:', e.message)
}
try {
  const tf = await import('@tiny-fish/sdk')
  console.log('tinyfish ok:', Object.keys(tf))
} catch (e) {
  console.error('tinyfish fail:', e.message)
}
