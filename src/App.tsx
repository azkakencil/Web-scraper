import { useState, useCallback } from 'react';

type TabType = 'html' | 'css' | 'javascript' | 'all';

interface ExternalResource {
  url: string;
  content?: string;
  loading?: boolean;
  error?: string;
  size?: number;
}

interface ScrapedCode {
  rawHtml: string;
  inlineCss: string[];
  inlineJs: string[];
  externalCss: ExternalResource[];
  externalJs: ExternalResource[];
  metas: Record<string, string>;
  title: string;
  images: string[];
  links: string[];
  allCssCode: string;
  allJsCode: string;
}

// Multiple CORS proxies for fallback
const CORS_PROXIES = [
  (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  (url: string) => `https://cors.x2u.in/${url}`,
  (url: string) => `https://corsproxy.org/?${encodeURIComponent(url)}`,
];

async function fetchWithProxy(url: string): Promise<string> {
  let lastError: Error | null = null;
  
  for (const proxyFn of CORS_PROXIES) {
    try {
      const proxyUrl = proxyFn(url);
      const response = await fetch(proxyUrl, {
        headers: {
          'Accept': '*/*',
        },
        signal: AbortSignal.timeout(20000),
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const text = await response.text();
      
      if (text && text.length > 10) {
        return text;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }
  }
  
  throw lastError || new Error('All proxies failed');
}

function resolveUrl(base: string, relative: string): string {
  try {
    if (relative.startsWith('//')) {
      return 'https:' + relative;
    }
    if (relative.startsWith('http://') || relative.startsWith('https://')) {
      return relative;
    }
    const baseUrl = new URL(base.startsWith('http') ? base : `https://${base}`);
    if (relative.startsWith('/')) {
      return baseUrl.origin + relative;
    }
    return baseUrl.origin + '/' + relative;
  } catch {
    return relative;
  }
}

// Extract source code from raw HTML
function extractFromRawHtml(html: string, _baseUrl: string) {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : 'No title';

  // Extract all CSS (inline styles and style tags)
  const inlineCss: string[] = [];
  
  // Extract style tags content
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let styleMatch;
  while ((styleMatch = styleRegex.exec(html)) !== null) {
    const content = styleMatch[1].trim();
    if (content) {
      inlineCss.push(content);
    }
  }

  // Extract inline styles from elements
  const inlineStyleRegex = /style\s*=\s*["']([^"']+)["']/gi;
  let inlineMatch;
  const inlineStyles: string[] = [];
  while ((inlineMatch = inlineStyleRegex.exec(html)) !== null) {
    inlineStyles.push(`/* Inline style element */\n${inlineMatch[1]}`);
  }
  if (inlineStyles.length > 0) {
    inlineCss.push(inlineStyles.join('\n\n'));
  }

  // Extract external CSS links
  const externalCssResources: ExternalResource[] = [];
  const cssLinkRegex = /<link[^>]+(?:href\s*=\s*["']([^"']+\.css[^"']*)["']|href\s*=\s*([^\s>]+\.css[^>\s]*))/gi;
  let cssLinkMatch;
  while ((cssLinkMatch = cssLinkRegex.exec(html)) !== null) {
    const href = cssLinkMatch[1] || cssLinkMatch[2];
    if (href && !href.includes('data:')) {
      const fullUrl = resolveUrl(_baseUrl, href);
      if (!externalCssResources.find((r: ExternalResource) => r.url === fullUrl)) {
        externalCssResources.push({ url: fullUrl });
      }
    }
  }

  // Extract JavaScript
  const inlineJs: string[] = [];
  
  // Extract script tags with content (not external scripts)
  const scriptRegex = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptRegex.exec(html)) !== null) {
    const content = scriptMatch[1].trim();
    if (content && content.length > 10) {
      inlineJs.push(content);
    }
  }

  // Extract external JS links
  const externalJsResources: ExternalResource[] = [];
  const jsLinkRegex = /<script[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let jsLinkMatch;
  while ((jsLinkMatch = jsLinkRegex.exec(html)) !== null) {
    const src = jsLinkMatch[1];
    if (src && !src.includes('data:') && !src.includes('about:blank')) {
      const fullUrl = resolveUrl(_baseUrl, src);
      if (!externalJsResources.find((r: ExternalResource) => r.url === fullUrl)) {
        externalJsResources.push({ url: fullUrl });
      }
    }
  }

  // Extract meta tags
  const metas: Record<string, string> = {};
  const simpleMetaRegex = /<meta[^>]+>/gi;
  let simpleMetaMatch;
  while ((simpleMetaMatch = simpleMetaRegex.exec(html)) !== null) {
    const tag = simpleMetaMatch[0];
    const nameMatch = tag.match(/(?:name|property|http-equiv)\s*=\s*["']([^"']+)["']/i);
    const contentMatch = tag.match(/content\s*=\s*["']([^"']*)["']/i);
    if (nameMatch && contentMatch) {
      metas[nameMatch[1]] = contentMatch[1];
    }
  }

  // Extract images
  const images: string[] = [];
  const imgRegex = /<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(html)) !== null) {
    if (!imgMatch[1].startsWith('data:')) {
      images.push(resolveUrl(_baseUrl, imgMatch[1]));
    }
  }

  // Extract other links
  const links: string[] = [];
  const linkRegex = /<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    if (!linkMatch[1].startsWith('#') && !linkMatch[1].startsWith('javascript:') && !linkMatch[1].startsWith('mailto:')) {
      links.push(linkMatch[1]);
    }
  }

  return {
    rawHtml: html,
    inlineCss,
    inlineJs,
    externalCss: externalCssResources,
    externalJs: externalJsResources,
    metas,
    title,
    images: [...new Set(images)].slice(0, 50),
    links: [...new Set(links)].slice(0, 50),
  };
}

export default function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<TabType>('html');
  const [scrapedData, setScrapedData] = useState<ScrapedCode | null>(null);
  const [copiedSection, setCopiedSection] = useState<string | null>(null);
  const [proxyStatus, setProxyStatus] = useState<string>('');
  const [resourcesProgress, setResourcesProgress] = useState({ css: 0, js: 0, total: 0 });

  const fetchExternalResources = useCallback(async (
    externalCss: ExternalResource[],
    externalJs: ExternalResource[],
    _baseUrl: string
  ): Promise<{ css: ExternalResource[], js: ExternalResource[] }> => {
    const totalResources = externalCss.length + externalJs.length;
    setResourcesProgress({ css: 0, js: 0, total: totalResources });
    
    const fetchCssPromises = externalCss.map(async (resource, index) => {
      setProxyStatus(`Mengambil CSS ${index + 1}/${externalCss.length}: ${resource.url.split('/').pop()}`);
      try {
        const content = await fetchWithProxy(resource.url);
        setResourcesProgress(prev => ({ ...prev, css: prev.css + 1 }));
        return { ...resource, content, loading: false, size: content.length };
      } catch (err) {
        setResourcesProgress(prev => ({ ...prev, css: prev.css + 1 }));
        return {
          ...resource,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to fetch'
        };
      }
    });

    const fetchJsPromises = externalJs.map(async (resource, index) => {
      setProxyStatus(`Mengambil JavaScript ${index + 1}/${externalJs.length}: ${resource.url.split('/').pop()}`);
      try {
        const content = await fetchWithProxy(resource.url);
        setResourcesProgress(prev => ({ ...prev, js: prev.js + 1 }));
        return { ...resource, content, loading: false, size: content.length };
      } catch (err) {
        setResourcesProgress(prev => ({ ...prev, js: prev.js + 1 }));
        return {
          ...resource,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to fetch'
        };
      }
    });

    const [cssResults, jsResults] = await Promise.all([
      Promise.all(fetchCssPromises),
      Promise.all(fetchJsPromises)
    ]);

    return { css: cssResults, js: jsResults };
  }, []);

  const handleScrape = useCallback(async () => {
    if (!url.trim()) {
      setError('Masukkan URL website yang valid');
      return;
    }

    let formattedUrl = url.trim();
    if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
      formattedUrl = 'https://' + formattedUrl;
    }

    setLoading(true);
    setError('');
    setScrapedData(null);
    setProxyStatus('Mengambil source code HTML...');

    try {
      const html = await fetchWithProxy(formattedUrl);
      
      setProxyStatus('Menganalisis struktur HTML...');
      const basicData = extractFromRawHtml(html, formattedUrl);
      
      // Set initial data with loading state
      const initialData: ScrapedCode = {
        ...basicData,
        externalCss: basicData.externalCss.map(r => ({ ...r, loading: true })),
        externalJs: basicData.externalJs.map(r => ({ ...r, loading: true })),
        allCssCode: '',
        allJsCode: '',
      };
      setScrapedData(initialData);

      // Fetch all external resources
      const { css, js } = await fetchExternalResources(
        basicData.externalCss,
        basicData.externalJs,
        formattedUrl
      );

      // Combine all CSS
      const allCssParts: string[] = [];
      if (basicData.inlineCss.length > 0) {
        allCssParts.push('/* ============================================ */');
        allCssParts.push('/* INLINE CSS FROM HTML */');
        allCssParts.push('/* ============================================ */');
        allCssParts.push(...basicData.inlineCss);
      }
      css.forEach(resource => {
        if (resource.content) {
          allCssParts.push('');
          allCssParts.push('/* ============================================ */');
          allCssParts.push(`/* FILE: ${resource.url} */`);
          allCssParts.push('/* ============================================ */');
          allCssParts.push(resource.content);
        }
      });

      // Combine all JavaScript
      const allJsParts: string[] = [];
      if (basicData.inlineJs.length > 0) {
        allJsParts.push('// ============================================');
        allJsParts.push('// INLINE JAVASCRIPT FROM HTML');
        allJsParts.push('// ============================================');
        allJsParts.push(...basicData.inlineJs);
      }
      js.forEach(resource => {
        if (resource.content) {
          allJsParts.push('');
          allJsParts.push('// ============================================');
          allJsParts.push(`// FILE: ${resource.url}`);
          allJsParts.push('// ============================================');
          allJsParts.push(resource.content);
        }
      });

      setScrapedData({
        ...basicData,
        externalCss: css,
        externalJs: js,
        allCssCode: allCssParts.join('\n'),
        allJsCode: allJsParts.join('\n'),
      });

      setProxyStatus('Selesai! Semua source code berhasil diambil.');
    } catch (err) {
      console.error('Scrape error:', err);
      setError(
        `Gagal mengambil source code. Pastikan URL valid dan website dapat diakses.\nError: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
    } finally {
      setLoading(false);
    }
  }, [url, fetchExternalResources]);

  const copyToClipboard = useCallback(async (text: string, section: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedSection(section);
      setTimeout(() => setCopiedSection(null), 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopiedSection(section);
      setTimeout(() => setCopiedSection(null), 2000);
    }
  }, []);

  const downloadFile = useCallback((content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const downloadAllFiles = useCallback(() => {
    if (!scrapedData) return;
    
    const hostname = getFilename();
    
    // Download HTML
    downloadFile(scrapedData.rawHtml, `${hostname}.html`);
    
    // Download combined CSS
    if (scrapedData.allCssCode) {
      setTimeout(() => downloadFile(scrapedData.allCssCode, `${hostname}-styles.css`), 200);
    }
    
    // Download combined JS
    if (scrapedData.allJsCode) {
      setTimeout(() => downloadFile(scrapedData.allJsCode, `${hostname}-scripts.js`), 400);
    }
    
    // Download individual external CSS files
    scrapedData.externalCss.forEach((resource, index) => {
      if (resource.content) {
        const filename = resource.url.split('/').pop() || `style-${index}.css`;
        setTimeout(() => downloadFile(resource.content!, filename), 600 + index * 100);
      }
    });
    
    // Download individual external JS files
    scrapedData.externalJs.forEach((resource, index) => {
      if (resource.content) {
        const filename = resource.url.split('/').pop() || `script-${index}.js`;
        setTimeout(() => downloadFile(resource.content!, filename), 800 + index * 100);
      }
    });
  }, [scrapedData, downloadFile]);

  const getTabContent = (): string => {
    if (!scrapedData) return '';
    
    switch (activeTab) {
      case 'html':
        return scrapedData.rawHtml;
      case 'css':
        return scrapedData.allCssCode || '/* Tidak ada CSS ditemukan */';
      case 'javascript':
        return scrapedData.allJsCode || '// Tidak ada JavaScript ditemukan';
      case 'all':
        return generateAllCode(scrapedData);
      default:
        return '';
    }
  };

  const generateAllCode = (data: ScrapedCode): string => {
    const parts: string[] = [];
    
    parts.push('/* ============================================');
    parts.push('COMPLETE WEBSITE SOURCE CODE');
    parts.push(`URL: ${url}`);
    parts.push('============================================ */');
    parts.push('');
    
    // HTML
    parts.push('<!-- ============================================ -->');
    parts.push('<!-- HTML SOURCE CODE -->');
    parts.push('<!-- ============================================ -->');
    parts.push(data.rawHtml);
    
    // CSS
    if (data.allCssCode) {
      parts.push('');
      parts.push('<!-- ============================================ -->');
      parts.push('<!-- ALL CSS CODE -->');
      parts.push('<!-- ============================================ -->');
      parts.push('<style>');
      parts.push(data.allCssCode);
      parts.push('</style>');
    }
    
    // JavaScript
    if (data.allJsCode) {
      parts.push('');
      parts.push('<!-- ============================================ -->');
      parts.push('<!-- ALL JAVASCRIPT CODE -->');
      parts.push('<!-- ============================================ -->');
      parts.push(data.allJsCode);
    }
    
    return parts.join('\n');
  };

  const getFilename = (): string => {
    try {
      const hostname = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
      return hostname.replace('www.', '');
    } catch {
      return 'website';
    }
  };

  const getTotalSize = (): string => {
    if (!scrapedData) return '0';
    let total = scrapedData.rawHtml.length;
    total += scrapedData.allCssCode.length;
    total += scrapedData.allJsCode.length;
    return (total / 1024).toFixed(2);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* Header */}
      <header className="border-b border-slate-700 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/20">
                <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                </svg>
              </div>
              <div>
                <h1 className="text-xl font-bold text-white">Complete Source Code Scraper</h1>
                <p className="text-sm text-slate-400">Ambil SEMUA source code dari website manapun</p>
              </div>
            </div>
            {scrapedData && (
              <div className="hidden sm:flex items-center gap-2 text-sm text-slate-400">
                <span className="px-3 py-1 bg-emerald-500/20 text-emerald-400 rounded-full font-medium">
                  Total: {getTotalSize()} KB
                </span>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* URL Input Section */}
        <div className="mb-8 rounded-2xl border border-slate-700 bg-slate-800/50 p-6 shadow-xl">
          <div className="mb-4 flex items-center gap-2 text-sm text-slate-400">
            <svg className="h-4 w-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Masukkan URL website untuk mengambil HTML, CSS, JavaScript, dan semua resource lainnya</span>
          </div>
          
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="relative flex-1">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4">
                <svg className="h-5 w-5 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                </svg>
              </div>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleScrape()}
                placeholder="https://example.com atau example.com"
                className="w-full rounded-xl border border-slate-600 bg-slate-700/50 py-3 pl-12 pr-4 text-white placeholder-slate-400 transition-colors focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                disabled={loading}
              />
            </div>
            <button
              onClick={handleScrape}
              disabled={loading || !url.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 px-8 py-3 font-semibold text-white shadow-lg shadow-emerald-500/25 transition-all hover:from-emerald-600 hover:to-teal-700 hover:shadow-xl hover:shadow-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <>
                  <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <span>Scraping...</span>
                </>
              ) : (
                <>
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  <span>Ambil Semua Source Code</span>
                </>
              )}
            </button>
          </div>

          {proxyStatus && loading && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-2 text-sm text-emerald-400">
                <svg className="h-4 w-4 animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
                </svg>
                <span>{proxyStatus}</span>
              </div>
              {resourcesProgress.total > 0 && (
                <div className="flex items-center gap-4 text-xs text-slate-400">
                  <span>CSS: {resourcesProgress.css}/{Math.ceil(resourcesProgress.total / 2)}</span>
                  <span>JS: {resourcesProgress.js}/{Math.ceil(resourcesProgress.total / 2)}</span>
                  <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-300"
                      style={{
                        width: `${((resourcesProgress.css + resourcesProgress.js) / resourcesProgress.total) * 100}%`
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4">
              <div className="flex items-start gap-3">
                <svg className="h-5 w-5 flex-shrink-0 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <p className="text-sm text-red-300 whitespace-pre-wrap">{error}</p>
              </div>
            </div>
          )}
        </div>

        {/* Results Section */}
        {scrapedData && (
          <div className="space-y-6">
            {/* Website Info Card */}
            <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6 shadow-xl">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-white">Informasi Website</h2>
                <div className="flex items-center gap-2">
                  <button
                    onClick={downloadAllFiles}
                    className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-600 px-4 py-2 text-sm font-medium text-white shadow hover:from-emerald-600 hover:to-teal-700 transition-all"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Download Semua File
                  </button>
                  <span className="px-3 py-1 text-xs font-medium bg-emerald-500/20 text-emerald-400 rounded-full">
                    ✓ Berhasil
                  </span>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
                <InfoCard
                  icon={
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                    </svg>
                  }
                  label="Title"
                  value={scrapedData.title}
                />
                <InfoCard
                  icon={
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  }
                  label="HTML Size"
                  value={`${(scrapedData.rawHtml.length / 1024).toFixed(2)} KB`}
                />
                <InfoCard
                  icon={
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    </svg>
                  }
                  label="CSS Files"
                  value={`${scrapedData.externalCss.length} files`}
                />
                <InfoCard
                  icon={
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                    </svg>
                  }
                  label="JS Files"
                  value={`${scrapedData.externalJs.length} files`}
                />
                <InfoCard
                  icon={
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                  }
                  label="Total CSS"
                  value={`${(scrapedData.allCssCode.length / 1024).toFixed(2)} KB`}
                />
                <InfoCard
                  icon={
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                    </svg>
                  }
                  label="Total JS"
                  value={`${(scrapedData.allJsCode.length / 1024).toFixed(2)} KB`}
                />
              </div>
            </div>

            {/* Code Viewer */}
            <div className="rounded-2xl border border-slate-700 bg-slate-800/50 shadow-xl overflow-hidden">
              {/* Tabs */}
              <div className="flex flex-wrap items-center gap-1 border-b border-slate-700 p-2 bg-slate-800/80">
                <TabButton
                  active={activeTab === 'html'}
                  onClick={() => setActiveTab('html')}
                  label="HTML"
                  color="emerald"
                  size={scrapedData.rawHtml.length}
                />
                <TabButton
                  active={activeTab === 'css'}
                  onClick={() => setActiveTab('css')}
                  label="CSS"
                  color="blue"
                  size={scrapedData.allCssCode.length}
                />
                <TabButton
                  active={activeTab === 'javascript'}
                  onClick={() => setActiveTab('javascript')}
                  label="JavaScript"
                  color="yellow"
                  size={scrapedData.allJsCode.length}
                />
                <TabButton
                  active={activeTab === 'all'}
                  onClick={() => setActiveTab('all')}
                  label="All Code"
                  color="purple"
                  size={scrapedData.allCssCode.length + scrapedData.allJsCode.length + scrapedData.rawHtml.length}
                />

                {/* Action Buttons */}
                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={() => downloadFile(getTabContent(), `${getFilename()}.${activeTab === 'html' ? 'html' : activeTab === 'css' ? 'css' : activeTab === 'javascript' ? 'js' : 'txt'}`)}
                    className="inline-flex items-center gap-2 rounded-lg bg-slate-600 px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-500"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Download
                  </button>
                  <button
                    onClick={() => copyToClipboard(getTabContent(), activeTab)}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-600"
                  >
                    {copiedSection === activeTab ? (
                      <>
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                        Tersalin!
                      </>
                    ) : (
                      <>
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                        Salin Semua
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Code Content */}
              <div className="p-0">
                {getTabContent() && getTabContent() !== '/* Tidak ada CSS ditemukan */' && getTabContent() !== '// Tidak ada JavaScript ditemukan' ? (
                  <div className="relative">
                    <pre className="overflow-x-auto p-6 text-sm leading-relaxed text-slate-300 max-h-[600px] overflow-y-auto bg-slate-900/80">
                      <code className="font-mono whitespace-pre-wrap break-words">{getTabContent()}</code>
                    </pre>
                    <div className="absolute bottom-2 right-2 text-xs text-slate-500 bg-slate-800 px-2 py-1 rounded shadow">
                      {getTabContent().split('\n').length} baris | {(getTabContent().length / 1024).toFixed(2)} KB
                    </div>
                  </div>
                ) : (
                  <div className="p-8 text-center text-slate-400 bg-slate-900/50">
                    {getTabContent() || 'Tidak ada kode yang ditemukan'}
                  </div>
                )}
              </div>
            </div>

            {/* External CSS Files */}
            {scrapedData.externalCss.length > 0 && (
              <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6 shadow-xl">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full bg-blue-500"></span>
                    CSS Files ({scrapedData.externalCss.length})
                  </h3>
                  <span className="text-sm text-slate-400">
                    {scrapedData.externalCss.filter(r => r.content).length} berhasil diambil
                  </span>
                </div>
                <div className="space-y-3">
                  {scrapedData.externalCss.map((resource, index) => (
                    <ResourceItem
                      key={`css-${index}`}
                      resource={resource}
                      index={index}
                      type="css"
                      onCopy={copyToClipboard}
                      onDownload={downloadFile}
                      copiedSection={copiedSection}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* External JS Files */}
            {scrapedData.externalJs.length > 0 && (
              <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6 shadow-xl">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full bg-yellow-500"></span>
                    JavaScript Files ({scrapedData.externalJs.length})
                  </h3>
                  <span className="text-sm text-slate-400">
                    {scrapedData.externalJs.filter(r => r.content).length} berhasil diambil
                  </span>
                </div>
                <div className="space-y-3">
                  {scrapedData.externalJs.map((resource, index) => (
                    <ResourceItem
                      key={`js-${index}`}
                      resource={resource}
                      index={index}
                      type="js"
                      onCopy={copyToClipboard}
                      onDownload={downloadFile}
                      copiedSection={copiedSection}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Meta Tags */}
            {Object.keys(scrapedData.metas).length > 0 && (
              <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6 shadow-xl">
                <h3 className="mb-4 text-lg font-semibold text-white">Meta Tags</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  {Object.entries(scrapedData.metas).map(([name, content], index) => (
                    <div
                      key={index}
                      className="rounded-lg bg-slate-700/50 p-4"
                    >
                      <div className="text-xs font-medium text-emerald-400 mb-1">{name}</div>
                      <div className="text-sm text-slate-300 break-all">{content}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Images */}
            {scrapedData.images.length > 0 && (
              <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6 shadow-xl">
                <h3 className="mb-4 text-lg font-semibold text-white">
                  Images ({scrapedData.images.length})
                </h3>
                <div className="max-h-48 overflow-y-auto space-y-2">
                  {scrapedData.images.map((img, index) => (
                    <div key={index} className="flex items-center justify-between rounded-lg bg-slate-700/50 px-4 py-2">
                      <span className="truncate text-sm text-slate-300 font-mono mr-4">{img}</span>
                      <button
                        onClick={() => copyToClipboard(img, `img-${index}`)}
                        className="flex-shrink-0 text-slate-400 hover:text-white"
                      >
                        {copiedSection === `img-${index}` ? (
                          <svg className="h-4 w-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (
                          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Features Section */}
        {!scrapedData && !loading && (
          <div className="mt-8">
            <h2 className="text-center text-2xl font-bold text-white mb-8">Yang Bisa Diambil</h2>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              <FeatureCard
                icon={<span className="text-2xl">📄</span>}
                title="HTML"
                description="Seluruh kode HTML asli dari halaman web"
                color="emerald"
              />
              <FeatureCard
                icon={<span className="text-2xl">🎨</span>}
                title="CSS"
                description="Semua CSS inline DAN file CSS eksternal"
                color="blue"
              />
              <FeatureCard
                icon={<span className="text-2xl">⚡</span>}
                title="JavaScript"
                description="Semua JS inline DAN file JavaScript eksternal"
                color="yellow"
              />
              <FeatureCard
                icon={<span className="text-2xl">📦</span>}
                title="Download All"
                description="Download semua file sekaligus dengan satu klik"
                color="purple"
              />
            </div>
            
            <div className="mt-8 rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Cara Penggunaan</h3>
              <div className="grid gap-4 sm:grid-cols-3">
                <Step number={1} text="Masukkan URL website yang ingin di-scrape" />
                <Step number={2} text="Klik 'Ambil Semua Source Code' dan tunggu proses selesai" />
                <Step number={3} text="Salin atau download semua kode yang sudah diambil" />
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="mt-12 border-t border-slate-700 bg-slate-900/50 py-6">
        <div className="mx-auto max-w-7xl px-4 text-center text-sm text-slate-400">
          <p>Complete Source Code Scraper - Tool lengkap untuk mengambil semua source code</p>
          <p className="mt-1">Gunakan secara bertanggung jawab dan hormati hak cipta.</p>
        </div>
      </footer>
    </div>
  );
}

function InfoCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-slate-700/30 p-4">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xs text-slate-400">{label}</div>
        <div className="mt-1 truncate text-sm font-medium text-white">{value}</div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  color,
  size,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  color: string;
  size: number;
}) {
  const colorClasses = {
    emerald: 'bg-emerald-500',
    blue: 'bg-blue-500',
    yellow: 'bg-yellow-500',
    purple: 'bg-purple-500',
  };

  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? `${colorClasses[color as keyof typeof colorClasses]} text-white`
          : 'text-slate-400 hover:bg-slate-700 hover:text-white'
      }`}
    >
      {label}
      {size > 0 && (
        <span
          className={`ml-1 rounded-full px-2 py-0.5 text-xs ${
            active ? 'bg-white/20' : 'bg-slate-600'
          }`}
        >
          {size > 1024 ? `${(size / 1024).toFixed(1)}KB` : `${size}B`}
        </span>
      )}
    </button>
  );
}

function ResourceItem({
  resource,
  index,
  type,
  onCopy,
  onDownload,
  copiedSection,
}: {
  resource: ExternalResource;
  index: number;
  type: 'css' | 'js';
  onCopy: (text: string, section: string) => void;
  onDownload: (content: string, filename: string) => void;
  copiedSection: string | null;
}) {
  const filename = resource.url.split('/').pop()?.split('?')[0] || `file-${index}.${type}`;
  const hasContent = !!resource.content;
  
  return (
    <div className="rounded-xl bg-slate-700/30 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 bg-slate-700/50">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className={`w-2 h-2 rounded-full ${type === 'css' ? 'bg-blue-400' : 'bg-yellow-400'}`} />
          <span className="text-sm font-medium text-white truncate">{filename}</span>
          {resource.size && (
            <span className="text-xs text-slate-400">({(resource.size / 1024).toFixed(2)} KB)</span>
          )}
          {resource.loading && (
            <span className="text-xs text-emerald-400 animate-pulse">Loading...</span>
          )}
          {resource.error && (
            <span className="text-xs text-red-400">Error: {resource.error}</span>
          )}
        </div>
        <div className="flex items-center gap-2 ml-4">
          <a
            href={resource.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-slate-400 hover:text-white p-1"
            title="Open in new tab"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
          {hasContent && (
            <>
              <button
                onClick={() => onCopy(resource.content!, `${type}-${index}`)}
                className="text-slate-400 hover:text-white p-1"
                title="Copy content"
              >
                {copiedSection === `${type}-${index}` ? (
                  <svg className="h-4 w-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
              </button>
              <button
                onClick={() => onDownload(resource.content!, filename)}
                className="text-slate-400 hover:text-white p-1"
                title="Download file"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>
      
      {/* Preview of content */}
      {hasContent && (
        <div className="px-4 py-3 bg-slate-900/50 max-h-32 overflow-auto">
          <pre className="text-xs text-slate-400 font-mono whitespace-pre-wrap break-words">
            {resource.content!.substring(0, 500)}{resource.content!.length > 500 ? '\n...' : ''}
          </pre>
        </div>
      )}
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
  color,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  color: string;
}) {
  const borderColors = {
    emerald: 'hover:border-emerald-500/50',
    blue: 'hover:border-blue-500/50',
    yellow: 'hover:border-yellow-500/50',
    purple: 'hover:border-purple-500/50',
  };

  return (
    <div className={`rounded-2xl border border-slate-700 bg-slate-800/50 p-6 shadow-xl transition-all ${borderColors[color as keyof typeof borderColors]}`}>
      <div className="mb-4">{icon}</div>
      <h3 className="text-lg font-semibold text-white">{title}</h3>
      <p className="mt-2 text-sm text-slate-400">{description}</p>
    </div>
  );
}

function Step({ number, text }: { number: number; text: string }) {
  return (
    <div className="flex items-start gap-4">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white font-bold">
        {number}
      </div>
      <p className="text-slate-300">{text}</p>
    </div>
  );
}
