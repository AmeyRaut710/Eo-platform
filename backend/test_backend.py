import urllib.request
import json

try:
    # Check backend status
    status = json.loads(urllib.request.urlopen('http://localhost:8000/api/status').read())
    print('Backend status:', status)

    # Check tilejson
    tilejson = json.loads(urllib.request.urlopen('http://localhost:8000/api/cog/tilejson').read())
    print('TileJSON:', tilejson)

    # Try to fetch a sample tile
    tile_url = tilejson['tiles'][0].format(z=12, x=2939, y=1843)
    print('Sample tile URL:', tile_url)
    print('Attempting to fetch tile...')
    try:
        tile_resp = urllib.request.urlopen(tile_url, timeout=10)
        print('Tile response:', tile_resp.status, tile_resp.getheader('Content-Type'))
        print('Success!')
    except Exception as e:
        print('Error fetching tile:', e)

except Exception as e:
    print('Error:', e)