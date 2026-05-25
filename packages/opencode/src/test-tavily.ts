console.log('Testing Tavily in compiled binary...')
try {
  const { tavily } = await import('@tavily/core')
  const client = tavily({ apiKey: 'tvly-test' })
  console.log('client created')
  await client.search('test')
} catch (e) {
  console.error('tavily fail:', e.constructor.name, e.message)
}
