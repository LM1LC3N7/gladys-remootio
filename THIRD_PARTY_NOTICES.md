# Third-party notices

This integration ports to JavaScript the Remootio Websocket API as described
by the official documentation and as implemented by the following project:
the frames (HELLO, AUTH, ENCRYPTED, PING, the actions, their responses and the
events), the encryption of the ENCRYPTED frames (AES-256-CBC, PKCS#7, the
HMAC-SHA256 over the `data` object), the authentication flow and the 31-bit
action counter. No file is copied, and nothing of it is installed at runtime.

## aioremootio

<https://github.com/ivgg-me/aioremootio>, version 1.0.0a21 (commit 7bf2b48)

```
Copyright 2021 Gergö Gabor Ilyes-Veisz

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

The full text of the Apache License 2.0 is the `LICENSE` file of this
repository (the same license). aioremootio ships no NOTICE file.

## Remootio Websocket API documentation

<https://github.com/remootio/remootio-api-documentation> (v1 to v3
specifications, commit d5f3cdd). The protocol is implemented from its
description; the worked example of its chapters 7 and 11 (example keys,
challenge, QUERY and answer of a real device) is used as test vectors in
`test/crypto.test.js`. Remootio is a trademark of its owner; this integration
is not affiliated with it.

## LM1LC3N7/gladys-bang-olufsen, gladys-opengarage, gladys-iskra

`src/remootio/websocket.js` (from gladys-bang-olufsen), `src/publisher.js`
(from gladys-ikea through gladys-opengarage), the release tooling and the
virtual timers of the tests (from gladys-iskra) come from integrations of the
same author, under the Apache License 2.0 of this repository.
