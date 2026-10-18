# Worker raster test font

`Abel-Regular.ttf` and its unmodified `OFL.txt` are from the official
[google/fonts Abel directory](https://github.com/google/fonts/tree/3b99d83d2625944fc0b8bd328d793fa819b92381/ofl/abel),
pinned at commit `3b99d83d2625944fc0b8bd328d793fa819b92381`.

- Font SHA-256: `8809dcad25318225052f88333e208c5aad4adcb7b2c934c135735ec19aa410b4`.
- License SHA-256: `4f4bc3806a1e55789c6ef75ca5fc628297b05292f74966474dc0d40324abc609`.

The SIL Open Font License 1.1 permits redistribution. The fixture outbound
service returns this real font for each production font face so the native
Worker test exercises the production font loader and renderer without network
access or system fonts. Production artwork, typography and dependencies are
unchanged.
