/**
 * TEST-ONLY self-signed TLS certificate for the in-process fake SMTP server.
 *
 * NOT A SECRET AND NOT A CREDENTIAL — a secret scanner flagging this file is
 * a false positive by construction: the key pair is public in the repository
 * by design, certifies only `localhost`/`127.0.0.1`, grants access to
 * nothing, and is used exclusively so the smtp-driver tests can perform a
 * real implicit-TLS handshake (the client trusts the certificate via the
 * adapter's explicit `trustedCaCertificates` seam — verification stays
 * enabled; no production code path ever references or trusts it, and this
 * module is imported only from test files). A committed fixture is used
 * instead of runtime generation because Node cannot mint certificates
 * without shelling out to a system `openssl`, which would make the test
 * suite environment-dependent. Never reuse this key pair anywhere.
 *
 * Regenerate with:
 *   openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
 *     -days 36500 -nodes -subj "/CN=localhost" \
 *     -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
 */

export const TEST_SMTP_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUIJeWETVN2zpb5N4/6Tzqr67X/HAwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDcxODExNTA0NloYDzIxMjYw
NjI0MTE1MDQ2WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCOWvFqChFbXoVItZ43X3ibCnCD3jFNLSx5nJRZ6OA0
6dPE7YvztMj2DbcQnu++rOSDCsznzVHElUa7xfxsMpoox4Q6PkOXVFz64rXHwDEk
ITrDj0jGckRwtdxhScpAGiucMcYZK8IkyHGQTUZUCAonCH0PikdOWBiIifNqVfEy
+qN7qMo9C8UY+UR+DhyXORiyFASngcFtnJv8klYbcW7CVD9WmZfvlG8iyFtv1Qe0
ttJJINn/AjKVHbIAsb3me7oMMmRq+KvqzwiN05dpj+EaPOgKE8gavCiDJ9OlTfGo
Dim0fmdo6mWW+x4rf1IIkm2dCYgEgbZ9qZOuTHmJ3DLtAgMBAAGjbzBtMB0GA1Ud
DgQWBBSdE7nRnlE3BOyOpxOagtjOL9ibdTAfBgNVHSMEGDAWgBSdE7nRnlE3BOyO
pxOagtjOL9ibdTAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAbbn8C8kv0RoGa2REUgqYIYDe+cNB
6akgdzeT3mUgHy6o4TzhHeb45eTFDCMgy25LXrH5NQh6zx37BgP1bhfxU4L4vTQT
9R0xPQzxnXy1wujoqBMrdTES6UEl0HrFvFZfGRtdnkLQOT/eg56ETAWLpmvRD7Yy
lgzxyv/aXvEZ/YGWSYk/0CMuEKVNUxtJvpPof6Bp3VHYR1XOVA64vjgNFi4Yzcaf
pf4IlmwLKHMvRPC6TmPjbELzK+Tpg9CpzydUAYaanFLLFMkiZSye7fMM8mzPqkZj
5RceWENrH37LSGWERFoTIQCq0rvXdgs5TI0s9xQMP3XX5fpi0Eb6iOOecA==
-----END CERTIFICATE-----
`;

export const TEST_SMTP_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCOWvFqChFbXoVI
tZ43X3ibCnCD3jFNLSx5nJRZ6OA06dPE7YvztMj2DbcQnu++rOSDCsznzVHElUa7
xfxsMpoox4Q6PkOXVFz64rXHwDEkITrDj0jGckRwtdxhScpAGiucMcYZK8IkyHGQ
TUZUCAonCH0PikdOWBiIifNqVfEy+qN7qMo9C8UY+UR+DhyXORiyFASngcFtnJv8
klYbcW7CVD9WmZfvlG8iyFtv1Qe0ttJJINn/AjKVHbIAsb3me7oMMmRq+KvqzwiN
05dpj+EaPOgKE8gavCiDJ9OlTfGoDim0fmdo6mWW+x4rf1IIkm2dCYgEgbZ9qZOu
THmJ3DLtAgMBAAECggEACWd9olU271PPt010PdE7TPbEFxoTJLeSxBfxfv0Q7r3x
xQUyZS+wxPyD9v+g8/ZFBFkuzzNzrupzqUz7j4RKRd5kYFqjqXgjylk2zBLozCu7
z5aEJsP+vHlvLSgsSc7QyblKDnijEz4ArplER6HeVdTMOj4W1tigCkkewQwbapQm
A3sQP94BMY6JahOUvkjMLF0yM2cW2GqeI9D393AtTZOClGKZwVqyj2WZZQ8F8j7u
vo0LLrhb3m7sbzfGijnICIlwAHoUzx8rNlSRLqd9JiehozpZ3E5tdNh9O+gHMOmX
mAjtaFDFcu8/8wsWpWBRP0lIZfNy1TXcyyXfbJ49OwKBgQDE9zfeDnuCBh/mcBDW
Jy/MQTMD/Kn8zOnq9c9BLHVax5VsDkIzHyHGTA/Hzh59wg/nx0fxCYsdnJiWq5Cz
G7HqbD94+bRZoeMYtQ2/XsiiCj2LdlQOWc2wn/1oNsY8AvYorSs1pUfPZRFzEZfc
Th+t+L3VtaqMOT1u4TCp3xucFwKBgQC5BZMlEXyJ77Z0C0UKA/mpUso0Vyhn2odR
H2maPvLPX+WiayDWurh/B1/73gAJREl+EK++A/MKhGcEjzYMH1qLSDt/oBeh4+4i
bo9qKro/4b3q9/lAy6V8v9bV9ZDW2XcsETLD8mVQLH2d1sK6u/VMc7CPYNq5w7dT
itCfxdp3mwKBgAZ4fKxd227dFqUyX0s5xFc4eR2Tal40uSaP5rwkYsKVtfHz0fbt
+eUS0J3mxpepDW623EUt5BUX9OdWQY2wxjqGTduCkIs1R0mjgQ0dZwfzwCvZuk8y
YhCAYQnQatjD3CRf9AByKpbEojseg9en9WB4wHvJ2Q18P+lpmniqLLUHAoGASqFg
CAy0omLpwoclMvQFiXIWk+QwLSvtdyBnlUsc3977nnb9yP+KGdscsViLxTEhP9N1
P/0R1MUxVJp7n4oqGJJrRYCK58crsAHOoXFYrRneZF/fz24Vc2tiOe2SncccFc9e
HcGxchRwGvGcnHviZxMnPb5Am7vBP9Z3bmr9Q08CgYAIoGUYPqGUehuIT55zrbwT
NMLUcbu0K8Jujt/r0ZVN4m6yzVqfhvSyx/3W7N/MnozQF4I0jaQ359+w+aa9EZ3i
iQUQctt0KTs5oL05lWcFIQQhl43DcdRGtvTiuJISDCHp4cqhvYT9UH40Rvp/jrIm
kulHLM0VfcDVD8ntpfJmkg==
-----END PRIVATE KEY-----
`;
