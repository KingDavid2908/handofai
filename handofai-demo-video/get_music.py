import re
import urllib.request
import json

url = 'https://pixabay.com/music/beats-starlights-corporate-digital-technology-389344/'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'})
html = urllib.request.urlopen(req).read().decode('utf-8', errors='ignore')

# Check for JSON-LD structured data
for m in re.finditer(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.DOTALL):
    try:
        data = json.loads(m.group(1))
        print("JSON-LD:", json.dumps(data, indent=2)[:1000])
    except:
        pass

# Find all URLs
for m in re.finditer(r'(https?://[^\"\'\s<>]+)', html):
    url = m.group(1)
    if 'mp3' in url.lower() or 'audio' in url.lower() or 'download' in url.lower():
        print("Found:", url)

# Search for the audioId or media ID  
for m in re.finditer(r'media[_-]?id["\'\s:=]+(\d+)', html, re.IGNORECASE):
    print("Media ID:", m.group(1))

# Search for download-related content
for m in re.finditer(r'(download|audio)[^=]*=["\']([^"\']+)["\']', html, re.IGNORECASE):
    print("Attr:", m.group(1), "=", m.group(2))

# Try the Pixabay API
try:
    api_url = 'https://pixabay.com/api/music/?key=&id=389344'
    api_req = urllib.request.Request(api_url, headers={'User-Agent': 'Mozilla/5.0'})
    api_resp = urllib.request.urlopen(api_req).read().decode()
    print("\nAPI response:", api_resp[:2000])
except Exception as e:
    print("API error:", e)
