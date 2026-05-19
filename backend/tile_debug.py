import urllib.request
import urllib.error
import json

url = 'http://127.0.0.1:8000/api/cog/tilejson?titiler_url=http://127.0.0.1:8001'
print('TileJSON URL:', url)
try:
    with urllib.request.urlopen(url, timeout=10) as r:
        data = json.load(r)
        print('TileJSON loaded:')
        print(json.dumps(data, indent=2))
        tile = data['tiles'][0]
        print('Sample tile URL:', tile)
        try:
            with urllib.request.urlopen(tile, timeout=10) as t:
                print('Tile OK', t.status)
                print('Content-Type', t.getheader('Content-Type'))
                print('Content length', t.getheader('Content-Length'))
                print('Sample bytes', t.read(100))
        except urllib.error.HTTPError as he:
            print('Tile HTTPError', he.code)
            print(he.read().decode('utf-8', errors='replace'))
        except Exception as e:
            print('Tile request failed', repr(e))
except urllib.error.HTTPError as he:
    print('TileJSON HTTPError', he.code)
    print(he.read().decode('utf-8', errors='replace'))
except Exception as e:
    print('TileJSON request failed', repr(e))
