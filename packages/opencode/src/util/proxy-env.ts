export namespace ProxyEnv {
  export function getProxyForUrl(url: string): string | undefined {
    const u = new URL(url)
    const noProxy = process.env.NO_PROXY || process.env.no_proxy
    if (noProxy) {
      const patterns = noProxy.split(",").map((s) => s.trim())
      if (patterns.some((p) => u.hostname.endsWith(p) || u.hostname === p)) return
    }
    return process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy
  }
}
