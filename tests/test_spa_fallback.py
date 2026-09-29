def test_client_route_deep_link_serves_index(client):
    res = client.get("/ui/meetings")
    assert res.status_code == 200
    assert '<div id="root">' in res.text


def test_nested_client_route_serves_index(client):
    res = client.get("/ui/attendance/import")
    assert res.status_code == 200
    assert '<div id="root">' in res.text


def test_missing_asset_still_404s(client):
    res = client.get("/ui/assets/does-not-exist.js")
    assert res.status_code == 404
