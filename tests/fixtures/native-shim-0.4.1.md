# Piko 0.4.1 native launcher fixture

`native-shim-0.4.1.base64` contains the 4,608-byte protocol-1 launcher emitted by the checksum-verified, installed Piko 0.4.1 release in an isolated temporary root using `setup` without `--path`.

- Release executable SHA-256: `3450316919b4df5229ebce3a8833240b53b0e0a96b7a92d44a30a1d76c0814c6`
- Decoded launcher SHA-256: `3d6d5bb9619515fd7f19986a418ea89390cc377bfd52319f866d9260064ab0f9`
- Windows development launcher SHA-256: `bdd2164ad26f44755496cf512bf2fa71ca9f46c83b128bc5f9ef2a0c9ecadf5d`

The two launcher builds implement the same relative executable path and command identity protocol. Tests verify that compatible launchers remain usable across self updates without replacing them, while changed executable bytes and unexpected companion configurations remain protected.
