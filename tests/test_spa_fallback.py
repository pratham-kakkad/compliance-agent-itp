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


def test_route_containing_an_email_address_serves_index(client):
    # A person's page is /ui/compliance/admin/users/<e-mail>: the dot must not make it look like a file.
    res = client.get("/ui/compliance/admin/users/jo.smith%40corp.com")
    assert res.status_code == 200
    assert '<div id="root">' in res.text


def test_missing_image_still_404s(client):
    assert client.get("/ui/brand/nope.png").status_code == 404
