// Fixed reviewed source coordinates and expression identities. No runtime registration.
const rows = [
  {
    code: "opg-001",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 276,
    column: 3,
    checkKind: "assert.equal",
    expressionSha256:
      "067738858d56f20afe6df518838bde5cd3adb66acd23479bfc522a8e641d56d2",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-002",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 277,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "0d8764fafb38756804c11fcfb983e59eecafd827b9fc669029e3983054cdac93",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-003",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 301,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "701842f6d49bb8ff8e351a9dc1159932586f97a658ec2f1278540ceb205fc212",
    description: "Dependency root cannot contain the project root",
  },
  {
    code: "opg-004",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 306,
    column: 3,
    checkKind: "assert.equal",
    expressionSha256:
      "3deee3d89965a5234751595b801155ca6d4c5212ffd13da2132551d5d3e6f2db",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-005",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 307,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "7089ed7f582c0dfc497183b4cbed7858b56d2da31082ba88049bcf5e30c3bc81",
    description: "Expected a genuine relative file-input key",
  },
  {
    code: "opg-006",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 315,
    column: 3,
    checkKind: "assert.equal",
    expressionSha256:
      "3c21bda6c0383e5bc5b1251beb14f6ea031cdf55332d4d3948e5d688d72f12d5",
    description: "Noncanonical file-input spelling",
  },
  {
    code: "opg-007",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 331,
    column: 3,
    checkKind: "assert.equal",
    expressionSha256:
      "067738858d56f20afe6df518838bde5cd3adb66acd23479bfc522a8e641d56d2",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-008",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 332,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "d92374718a7753993207dda98bb68317a42bf67e364b18912b457b73eb747f5e",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-009",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 333,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "9ed442fe39cee9a4a28c09952df57613adbaebb12dd735d0de04e73c8d3bac2b",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-010",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 334,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "b8ed6dba9182aec3178d4c8faab1b210e08278cd4dc92e21d720bba4a28bbc72",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-011",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 339,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "01c5130cb52e93b4897683c313e6def6158374a37b0c1e808ab768e1025451b9",
    description: "Output escaped the reviewed root",
  },
  {
    code: "opg-012",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 348,
    column: 3,
    checkKind: "assert.equal",
    expressionSha256:
      "1f004832b5f357fbfe10312fe4b5bb8bc13ace779bae573de46679567214737f",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-013",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 349,
    column: 3,
    checkKind: "assert.equal",
    expressionSha256:
      "b0ee8bb42520fd2e8a1ebb6ee3da300d95b81caf98827f6a1575a67e19abdc5f",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-014",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 350,
    column: 3,
    checkKind: "assert.equal",
    expressionSha256:
      "b33121460359b42046782a7ae4194a104846815d055aa6ce74018536eab933fb",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-015",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 351,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "0511b92f6169be863341723f4e1fc94a43e8ab9380a18f7ebbfe0fb888c2ff5c",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-016",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 373,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "17aab6b880a71bacd1d9f913859f55f6aea6edaf7dcd8923c802afe77f8f2c10",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-017",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 378,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "b0c254fc90621855d52b2eb74f658d019d6f287192ecfd54eb51318c38a53c7a",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-018",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 384,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "0fed840a880f01458440caec6e6207a4fa9ba207a508e44bd56ffd7822493093",
    description: "Invalid source-map VLQ",
  },
  {
    code: "opg-019",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 394,
    column: 7,
    checkKind: "assert.equal",
    expressionSha256:
      "fe5258e34d7650133084b655fb054675e9b05b1bf9e357adeabe6f96c23a9d6b",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-020",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 395,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "25829edb704785ae2f7bb6b8267f5804fe80b6613e1d57397855e6126dab70db",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-021",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 398,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "153d34c440cc2cea0e3ba6f2549e5e8cb8118940ff0231629e32d392f430ab24",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-022",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 400,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "01eae3212339c7fb0edc2dbf3ee95cb24c2de67f44c07452c899776d99be15c2",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-023",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 402,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "8f2585f06450a0cbe4111a9af58f7bc3191879b12981ef5fe178c758f6e547d1",
    description: "Whole-graph mapping budget exceeded",
  },
  {
    code: "opg-024",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 418,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "4d114a40861c973ba915819633e72796f7497398029c52aa330fb68c9972e39d",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-025",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 419,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "bfbe41e18d94f414c23b75095ce0039dec09ffbbd5ed465e10658ccd6266ec70",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-026",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 424,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "226514a09d49b423cabb36b4436d73f78e9dfde649cd1d51c5fc6f770336a900",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-027",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 425,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "1fe8d8617f581e9b487a460fab045d667dfbd12a83b684916dcd50f8aa1a49f5",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-028",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 429,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "683ef1af91d1d82713c0dbf4edb2bd2343f5026604b87b56d34c3623dc3abace",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-029",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 431,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "e23f90e4845c76bfd8c6a3b6c2981f35e30011ff5330bd711416589a3fd88959",
    description: "Whole-graph mapping budget exceeded",
  },
  {
    code: "opg-030",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 460,
    column: 5,
    checkKind: "assert.ok",
    expressionSha256:
      "823682b5230f42901aeb8f920d9590a73394d481329bcba49abd266c7da29ed3",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-031",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 463,
    column: 5,
    checkKind: "assert.ok",
    expressionSha256:
      "a0b39260a6fbfdea5d6f68419cd8d2c6a3340d78d66d3e39f6b17555428def45",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-032",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 464,
    column: 5,
    checkKind: "assert.ok",
    expressionSha256:
      "aee132f26624c62480636f8101f9df448a9273009ef4e19858553480029f8df8",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-033",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 466,
    column: 7,
    checkKind: "assert.equal",
    expressionSha256:
      "b3579d0b5c5b87861b4104076b91a08a74e9612064c76a9831d5d9c10b96cf8c",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-034",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 467,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "c2ecaddc983b3b5b6b3031f99b88b7e6b913fde098ba7645e18e301ef9208a1a",
    description: "Supplied pg-native or native addon is forbidden",
  },
  {
    code: "opg-035",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 476,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "75fe4312c3a331370ac771cb8800dbae1ce4cf3f641a271df00dea33d929ba13",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-036",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 491,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "2dfd0f6a6b96c3cf37c6eedad46cd7a0e2c553766935656faa8418fc761d450e",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-037",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 493,
    column: 9,
    checkKind: "assert.equal",
    expressionSha256:
      "60bac7fd68cd25224ca6e21941d73b10d0abb22ff5ef9140067c813b0c62077d",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-038",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 494,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "4827892d23e83d4308cba56e9493dd3a08624517d61e97a0dc74f04d86c43e9b",
    description: "Supplied native dependency is forbidden",
  },
  {
    code: "opg-039",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 531,
    column: 5,
    checkKind: "assert.ok",
    expressionSha256:
      "0e937279a03daae13290245b89213ded256d2afb94664d06a169b3b46957118b",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-040",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 532,
    column: 5,
    checkKind: "assert.ok",
    expressionSha256:
      "b68f8cd32d5b236526acd195735264fdc0971134db84045604114bd840afe672",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-041",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 537,
    column: 5,
    checkKind: "assert.equal",
    expressionSha256:
      "8a9c53361f1eaea51ab6a5cda617fedfaaafca6a6f028af37756aa870fd8ad02",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-042",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 540,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "f037d5d65762724707ed4c3dc53d02f533ab187b1af09859cf99c5e9e8a60174",
    description: "Supplied native runtime module is forbidden",
  },
  {
    code: "opg-043",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 548,
    column: 7,
    checkKind: "assert.equal",
    expressionSha256:
      "8ddba3f99ffdbc61c0d70c2321c12cfa5edcfb87111f7c127e031603d3d2a1d8",
    description: "Discarded records require the complete optional pg proof",
  },
  {
    code: "opg-044",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 557,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "03affcd55f9b756f77dad05ed0b3b06f63a6de769325c3597f2d3f2882fe3624",
    description: "Missing input import provenance",
  },
  {
    code: "opg-045",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 564,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "02b2be40bdfb9e8e0c58312de7d739eff505ae0c6e79796af29f41d5aa60dcd3",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-046",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 567,
    column: 5,
    checkKind: "assert.deepEqual",
    expressionSha256:
      "19d99e87e28bb244ccb94117430c301a1bf5b4d2f5040e2c61333f584b9f6ca0",
    description: "Existing assert.deepEqual predicate",
  },
  {
    code: "opg-047",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 573,
    column: 9,
    checkKind: "assert.match",
    expressionSha256:
      "0ffd2d842e4773314d70a1228e0b0a4155fc8ffe8c2f68be6554e2a96da6a5a2",
    description: "Existing assert.match predicate",
  },
  {
    code: "opg-048",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 574,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "7939aa0bf70ec2a7b62e35d57452143453cb067f4cb849c4077706fb925f3f0e",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-049",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 582,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "77e2d5b339c01d3b194c4e96891bbcee21a02a2be24d96f112ab265cea14ba6d",
    description: "Duplicate logical/canonical input alias",
  },
  {
    code: "opg-050",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 592,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "f9e0d0e60c5cb8fcb92da18c072578c1d92095ac4ac60d518658e88382ead2b3",
    description: "Internal edge has no exact input key",
  },
  {
    code: "opg-051",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 602,
    column: 9,
    checkKind: "assert.equal",
    expressionSha256:
      "9bab7dd6290419c1afc49197d2f6813decfa6c2c22b7f07aeec43eec3c998740",
    description: "Internal edge uses an input identity alias",
  },
  {
    code: "opg-052",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 623,
    column: 5,
    checkKind: "assert.deepEqual",
    expressionSha256:
      "3418c0dead0a1111faec4974443805b8cf303957a3b619d41f8f2898b2d414f2",
    description: "Existing assert.deepEqual predicate",
  },
  {
    code: "opg-053",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 629,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "ebf1fb05abd0105aca2b2b13e75d19ac6b378a89905146a7f0e0c8e811e17be8",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-054",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 634,
    column: 7,
    checkKind: "assert.equal",
    expressionSha256:
      "5d69e80f1a64092cdc4de0bbe0a1b0ade5ed3136c4daa0f23788201d013ef95d",
    description: "Pinned optional pg source changed",
  },
  {
    code: "opg-055",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 636,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "7803dbd5c58d3a5d48ade9655717f7ec3d31520edb26dda0679dd3510c150ecf",
    description: "Unique pinned input identity absent",
  },
  {
    code: "opg-056",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 637,
    column: 7,
    checkKind: "assert.equal",
    expressionSha256:
      "0262fa30a8a56280ac9f5a787dc8c41e8abd53eef9c2a9dda50d6b43e9d93f92",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-057",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 646,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "018f8f7bb9757b08430573aeff519b998cc20aa00b787bd49d0d0018fb875eb3",
    description: "Pinned native branch association absent",
  },
  {
    code: "opg-058",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 659,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "75fe4312c3a331370ac771cb8800dbae1ce4cf3f641a271df00dea33d929ba13",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-059",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 666,
    column: 11,
    checkKind: "assert.equal",
    expressionSha256:
      "9f9dd486fa31770e7a87ca48c84fa201e7dc8b3a0aa6083bd8b0ae64593a5cbd",
    description: "Optional require originates from an unreviewed input",
  },
  {
    code: "opg-060",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 673,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "340a2dac79169ab493b57510e80040287a5cdb139b0fb26d5a9d032c0768cd4b",
    description: "Resolved native input forbidden",
  },
  {
    code: "opg-061",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 679,
    column: 5,
    checkKind: "assert.equal",
    expressionSha256:
      "b681b177aa3615ab992277ace6cfbe84328a9053072371cd9864347fddff0f12",
    description: "Exactly one optional input require is required",
  },
  {
    code: "opg-062",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 687,
    column: 5,
    checkKind: "assert.ok",
    expressionSha256:
      "8e619f20c353870f864a5dbe78f71da79c13d925ec0785ca9f2915a7a4d4a10c",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-063",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 691,
    column: 5,
    checkKind: "assert.deepEqual",
    expressionSha256:
      "b5df78690667047a1693799c22cef925d1b8d0d101626d53bc6dd191e8280d02",
    description: "Existing assert.deepEqual predicate",
  },
  {
    code: "opg-064",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 712,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "590e05be0cbb48b5359f56da6bbc9c23d2e28e962efc1b593d1ff29f51ed1dcb",
    description: "Importing output is not registered",
  },
  {
    code: "opg-065",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 722,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "d2714d23055524c444187c6b7e0ef5e661cacc3096310cfc11f8105c0c17f2fd",
    description: "Output contribution has no exact input key",
  },
  {
    code: "opg-066",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 732,
    column: 9,
    checkKind: "assert.equal",
    expressionSha256:
      "ad764a9d2d179ceec7151a805a85cbf20cf0ed4b38b85fad583f4113de034e03",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-067",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 733,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "2bef15ff95c2daeac3504565bef2694b8604341d40b75c5fe50a12738f37eddb",
    description: "Duplicate contribution alias",
  },
  {
    code: "opg-068",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 740,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "4c501287c992dda45e96948cf42a157de05ed2194f05edbd0dc22ddbc00b3230",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-069",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 746,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "05e2d227392add6bb0ce1028fc4275ef8966d9fa3fdf61b3294e75451d437b91",
    description: "Whole-graph output budget exceeded",
  },
  {
    code: "opg-070",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 750,
    column: 7,
    checkKind: "assert.equal",
    expressionSha256:
      "28dddbe12e97711edc57ab09b57ff140b27111cc3d6a14d08ac9c63fb2c534db",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-071",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 752,
    column: 7,
    checkKind: "assert.equal",
    expressionSha256:
      "3deba094d39c8237a896301f6254810e7aa95951e4c64847b60b0bf99d074a94",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-072",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 754,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "3fcce9c2491ead56ae556714d01ef47c809838391d4c33b0dc8adeae04c9e35d",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-073",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 760,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "1983ac60bafce848078171e877b5e0345b5c8be2e43f09231869dcc1803fba9d",
    description: "Whole-graph source-map budget exceeded",
  },
  {
    code: "opg-074",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 764,
    column: 7,
    checkKind: "assert.equal",
    expressionSha256:
      "80ec3c13279a5f729fd3020f0b69086cbf28cac97cbc7cf0e22dd9f6508bd918",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-075",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 772,
    column: 7,
    checkKind: "assert.equal",
    expressionSha256:
      "84bceb1a47f8e39394e1f449520bc19f7ea42a09a510abfff19b0e069b2e5c32",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-076",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 773,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "4e4d684acdfa5be1731a020b050863c0079dc8e08dceb284a8f5f603cc67909e",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-077",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 774,
    column: 7,
    checkKind: "assert.equal",
    expressionSha256:
      "8bfa6432f8e35ce222473b336deaa0cc41aa59e0a1ea04d98928f97e0a57468a",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-078",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 775,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "b2ed02a5ec34fcd3d5b4b70a525698f99cca6e0c42ebf7662112565d39c94797",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-079",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 780,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "857dddf654dd850dbee884ecd7912c59e1bc80d7b8ff471f808360ef590a9741",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-080",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 784,
    column: 7,
    checkKind: "assert.equal",
    expressionSha256:
      "912bcbd45e646146c9eae36a11d2f1cd575be1b3be252aa8519739e0336debe5",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-081",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 785,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "381afdccefb7196f56754de6c837922a644dfdd083f2d67708a7e006f01f048e",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-082",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 786,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "72f4db4163a9a369468cf4f30ce05bd0bc09ed561cb92760c5ab7c79f7f7741b",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-083",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 791,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "a977cd7225e98b05ae0cfbe0f52b609c975e7c7d936ff344f41d2b6f59106042",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-084",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 813,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "0e3b36562cb6540ed3a71e20954ec718d13a8f70581809469704a71344eb552e",
    description: "Duplicate source-map alias",
  },
  {
    code: "opg-085",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 816,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "36dbc5a19703768577ea707050904f5c922539e28d5d730b17510e434866f4ca",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-086",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 818,
    column: 11,
    checkKind: "assert.equal",
    expressionSha256:
      "7284b34f2a0e849c8bfc961b24dd6db2b77d55fe3e1b6cbb5673ac20871234b9",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-087",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 819,
    column: 11,
    checkKind: "assert.equal",
    expressionSha256:
      "e45f79b3bb7283cd015f6f4f190f19b4201bdd94cb65d960c1fec6030ae5ab48",
    description: "Source-map content changed",
  },
  {
    code: "opg-088",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 826,
    column: 9,
    checkKind: "assert.equal",
    expressionSha256:
      "b48708cf5b1726d5ce6c82d85312d7cf894228e602af00bfdfb5d8775db43d89",
    description: "Contributing source absent from associated output map",
  },
  {
    code: "opg-089",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 832,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "16f71a7b1a1f709f2458030804d5f7412cda030cbbdf809cdbe3f87322c3fa4e",
    description: "Source-map content has no generated mapping",
  },
  {
    code: "opg-090",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 846,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "089f356d64289a42503f5c49be76ee11fb31c950e98ff197fa2b31d08c4779e7",
    description: "Duplicate discarded importer map alias",
  },
  {
    code: "opg-091",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 851,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "36dbc5a19703768577ea707050904f5c922539e28d5d730b17510e434866f4ca",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-092",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 854,
    column: 11,
    checkKind: "assert.equal",
    expressionSha256:
      "7dc550c11113cfdfc5011b8cf26aefc5970fca53ca875ee073777be4abf46a3d",
    description: "Existing assert.equal predicate",
  },
  {
    code: "opg-093",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 855,
    column: 11,
    checkKind: "assert.equal",
    expressionSha256:
      "f654a7e68dc3774b673fa2e40d94e093760daf5424174c8bef91fe9e71bd785a",
    description: "Discarded importer map byte count changed",
  },
  {
    code: "opg-094",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 860,
    column: 11,
    checkKind: "assert.equal",
    expressionSha256:
      "ae543419cae77eb6fd9c8a61ab985dd5e171bc9486365ef670d9053675ce561d",
    description: "Discarded importer map source changed",
  },
  {
    code: "opg-095",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 867,
    column: 9,
    checkKind: "assert.equal",
    expressionSha256:
      "3d97ce2bfe4d338f8f20d17fc84200ac17cffc9a4a46a820830e4e3b70483b5a",
    description: "Contributing discarded importer absent from map",
  },
  {
    code: "opg-096",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 872,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "ced0a809838f224f53e1dfecdf6940fdc2e45988265cc49600d98bf2c5ee71c3",
    description: "Discarded importer has no genuine mapping",
  },
  {
    code: "opg-097",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 878,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "75fe4312c3a331370ac771cb8800dbae1ce4cf3f641a271df00dea33d929ba13",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-098",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 886,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "56f0e7ef92cf01c25d09f08cc3c2084126d53dbe52d03b251f40e52a6131223b",
    description: "Optional require lacks matching native-client contribution",
  },
  {
    code: "opg-099",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 898,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "fe0153b77b92d963139bbaf9c85c40fcac5d78613c062ac8d10f51adb5e61084",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-100",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 899,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "d57400b8306387b47348a353b094c96d4f00d4cad9913ef21100c77693dc1503",
    description: "Optional require statement has no generated mapping",
  },
  {
    code: "opg-101",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 910,
    column: 9,
    checkKind: "assert.equal",
    expressionSha256:
      "adcd7dd62a71174624ff6920d5ea0ce36cd8340f2907e30d1a936978f6ec20bd",
    description: "Expected one emitted optional require call",
  },
  {
    code: "opg-102",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 920,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "55f8724f4c7a213c0e0434f8ed09c86a0c2665500eec73642e9339f9ef3023e7",
    description: "Emitted require call lacks source-map origin",
  },
  {
    code: "opg-103",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 940,
    column: 5,
    checkKind: "assert.ok",
    expressionSha256:
      "3cd6bfc5330924136fb23f7d5d7ca1df50a8e322571038b6ac95404c4e80b807",
    description: "Incomplete discarded-input proof",
  },
  {
    code: "opg-104",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 944,
    column: 5,
    checkKind: "assert.deepEqual",
    expressionSha256:
      "8883cb55f8270bab7427f828650c291143e5d08d2e5a5f812ca5fa52db0daeb7",
    description: "Existing assert.deepEqual predicate",
  },
  {
    code: "opg-105",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 948,
    column: 5,
    checkKind: "assert.equal",
    expressionSha256:
      "b06b6f19543dce8d70c52abc340a94e8bb19ac88fd7539cdd4ac21b70c2a6d0a",
    description: "Exactly one unresolved optional output require is admitted",
  },
  {
    code: "opg-106",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 956,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "75fe4312c3a331370ac771cb8800dbae1ce4cf3f641a271df00dea33d929ba13",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-107",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 957,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "e4db59eeac68260e199e98f3f7316493348ef0b6578aac85065b682a6a4cc58a",
    description: "Existing assert.ok predicate",
  },
  {
    code: "opg-external-refusal",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 60,
    column: 3,
    checkKind: "throw",
    expressionSha256:
      "63dfbe7792539312760864e533f8c099687f44f5616505924578a6b247bbb012",
    description: "Unapproved external import refusal",
  },
  {
    code: "opg-operation-absolute",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 275,
    column: 34,
    checkKind: "function-boundary",
    expressionSha256:
      "a4330821987f65aeb3d9a4c3355c1825c3ad0f7d9f99b1a1ccc73c1f455f0a03",
    description: "Existing absolute helper operation failure",
  },
  {
    code: "opg-operation-owner-source-identity",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 298,
    column: 11,
    checkKind: "function-boundary",
    expressionSha256:
      "7eaf0d48ce7927ef27376af54958f558530d3e20421006fd7a2c2fc3f18c13c9",
    description: "Existing ownerSourceIdentity helper operation failure",
  },
  {
    code: "opg-operation-relative",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 330,
    column: 34,
    checkKind: "function-boundary",
    expressionSha256:
      "a662386ebc80b2f6249bb48c5c2d26361d6dfbbad4f75627434737229cf8badf",
    description: "Existing relative helper operation failure",
  },
  {
    code: "opg-operation-within",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 338,
    column: 45,
    checkKind: "function-boundary",
    expressionSha256:
      "0bf3b445daaf5a68d2697cfc7e5207c4951af579c1fcaebcb5cd20437f4661e1",
    description: "Existing within helper operation failure",
  },
  {
    code: "opg-operation-supplied-native",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 344,
    column: 40,
    checkKind: "function-boundary",
    expressionSha256:
      "ee4035631ae933339fab80750e150a62f9188a8c591b8553f26093931957c02d",
    description: "Existing suppliedNative helper operation failure",
  },
  {
    code: "opg-operation-exact-optional",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 347,
    column: 50,
    checkKind: "function-boundary",
    expressionSha256:
      "3bab552c38e61c452ea096fc7ac3de405cd335861cb5bad126627ecaa6bf8412",
    description: "Existing exactOptional helper operation failure",
  },
  {
    code: "opg-operation-decode-mappings",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 362,
    column: 14,
    checkKind: "function-boundary",
    expressionSha256:
      "36ed1855b401e573e12dd892291e3b02dbb8b484ba282bc397d75efa95e3af95",
    description: "Existing decodeMappings helper operation failure",
  },
  {
    code: "opg-operation-validate",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 449,
    column: 78,
    checkKind: "function-boundary",
    expressionSha256:
      "7f7331d8f27ffc3a9e1676b83ccdf80c51a0f4f5708d90e5956263a39f23f2db",
    description: "Existing optional proof operation failure",
  },
  {
    code: "discarded-001",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 46,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "b91b6456fe2a3506b7022b00e4ac9fe7619a48fb03cc0d53e073691dc0dd5b26",
    description: "Expected proof data object",
  },
  {
    code: "discarded-002",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 54,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "87eb8e2fc3e4e3bd3371867791d5bb35dc6cab1413aa3fe2836f191cb162ff12",
    description: "Unexpected proof object prototype",
  },
  {
    code: "discarded-003",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 63,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "8f0ac71df89a72bd310f7c5f6541e079ccd5cfc1dc3a56994d2edcb61a291621",
    description: "Proof accessor forbidden",
  },
  {
    code: "discarded-004",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 69,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "031cf937c00c07027ba0e434c87cafda71797c874c4358dee78f828519bfc811",
    description: "Proof inventory budget exceeded",
  },
  {
    code: "discarded-005",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 71,
    column: 5,
    checkKind: "assert.equal",
    expressionSha256:
      "b3579d0b5c5b87861b4104076b91a08a74e9612064c76a9831d5d9c10b96cf8c",
    description: "Existing assert.equal predicate",
  },
  {
    code: "discarded-006",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 73,
    column: 5,
    checkKind: "assert.ok",
    expressionSha256:
      "4b0ae6b93cf0967f9ba0abd387957e3f237f515de6348622572b064c738c7081",
    description: "Hidden/accessor proof entry",
  },
  {
    code: "discarded-007",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 90,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "92b9048542dbe7e24d1cf9b15a14e208dab2117d5a2b1869d11c97e52dede5c5",
    description: "Expected inert proof bytes",
  },
  {
    code: "discarded-008",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 95,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "7075db9e1dd00d05b49835076ed2ab88cffd30769dc5f2a325a263240ca68109",
    description: "Proof byte budget exceeded",
  },
  {
    code: "discarded-009",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 96,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "25786921ae227e68b82de48e78706d25b070e54e29436ca5f87fbcb10b4eeaf6",
    description: "Shared proof bytes forbidden",
  },
  {
    code: "discarded-010",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 110,
    column: 3,
    checkKind: "assert.equal",
    expressionSha256:
      "c1911caba356bc8e0d260b4595cceddb50f782ccc39640c56bfacc8a0e67b681",
    description: "Pinned proof byte count changed",
  },
  {
    code: "discarded-011",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 111,
    column: 3,
    checkKind: "assert.equal",
    expressionSha256:
      "9864626f9fce4b5dc0690474320a2f299ed1cfdc5c5446204e6870f4b7112caa",
    description: "Pinned proof source changed",
  },
  {
    code: "discarded-012",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 112,
    column: 3,
    checkKind: "assert.equal",
    expressionSha256:
      "ceb1b09e9043c7b032894cd35b988d666dfd66a19b9938fdc59d89db45cf0911",
    description: "Pinned proof Git blob changed",
  },
  {
    code: "discarded-013",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 135,
    column: 5,
    checkKind: "assert.ok",
    expressionSha256:
      "d0e70007a71b88ade172b4b2613ff7eb1be42d63801a727140cd1eee071cedd4",
    description: "Unexpected discarded-input evidence",
  },
  {
    code: "discarded-014",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 146,
    column: 3,
    checkKind: "assert.deepEqual",
    expressionSha256:
      "9722c96ffd411b45312fbc65dccf1412e5cc6df09dc186d950514a60335609b3",
    description: "Missing erasure configuration custody",
  },
  {
    code: "discarded-015",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 158,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "f6f946a89779853e20b54c6e7d9127068d6609e7567f56767c05f11da664c6f8",
    description: "Whole-config byte budget exceeded",
  },
  {
    code: "discarded-016",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 164,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "4a28f398aa2abfb6cde73419161715db7e0bf151e93d967dc39e0dfc43124635",
    description: "Missing complete import inventory",
  },
  {
    code: "discarded-017",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 172,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "72cdd2671e6393c4ed95b665b2cf0e21b2ef996821e1b5a8862c957588394a4f",
    description: "Sparse/accessor import record",
  },
  {
    code: "discarded-018",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 182,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "c7493e98e2af6a7991c443a14b89f9b961c00a4371b291f7c02c510618dc3d5f",
    description: "Expected canonical input map",
  },
  {
    code: "discarded-019",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 189,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "a1872f708a44dcbce7201e727e4569c68b04802ee71a444700f1ce134dafce55",
    description: "Input identity budget exceeded",
  },
  {
    code: "discarded-020",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 194,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "baf2caff9a981b8f41e2883762c5397fe440f43dd7e8964731a5d35a2b28b2a1",
    description: "Malformed canonical input key",
  },
  {
    code: "discarded-021",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 201,
    column: 3,
    checkKind: "assert.equal",
    expressionSha256:
      "19b2e2e45d6a337459693635d49fd36b44cb231ff1584fd58bc3eaaf55166d08",
    description: "Duplicate canonical input key",
  },
  {
    code: "discarded-022",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 213,
    column: 5,
    checkKind: "assert.ok",
    expressionSha256:
      "c6714c32bec3493604857089794c123d9b3b7e20ba9a172e7b6c74a47c3d1ff4",
    description: "Reviewed importer absent",
  },
  {
    code: "discarded-023",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 216,
    column: 3,
    checkKind: "assert.equal",
    expressionSha256:
      "05e87b78346d2848282dd886b537be37a8f66f3650032c9e75dfa2981315c317",
    description: "Duplicate importer identity",
  },
  {
    code: "discarded-024",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 244,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "d986047ca003905996cd500451e2ee75906991daf7a64f534b76ddf849c82462",
    description: "Malformed metadata byte count",
  },
  {
    code: "discarded-025",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 252,
    column: 9,
    checkKind: "assert.equal",
    expressionSha256:
      "b1815fdfeb9a903e153f02c94881a66fd62c9052e477baa99b164e92c07d14de",
    description: "Reviewed importer byte count changed",
  },
  {
    code: "discarded-026",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 258,
    column: 7,
    checkKind: "assert.ok",
    expressionSha256:
      "b1349c34a1d8d6bc277a39c2f17e26a19295062a6719fd14478a31190c47474f",
    description: "Whole-scope import budget exceeded",
  },
  {
    code: "discarded-027",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 267,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "8149cafd1bde6cb0cbd37558c541da63c09a99f314611d5957c0cb2a2a23d125",
    description: "Malformed import path",
  },
  {
    code: "discarded-028",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 273,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "14b17b3a0bf9f4791d31d4f3fe4b971dfd2e8d7303aac567f19a9ef5fc7f54c2",
    description: "Malformed import kind",
  },
  {
    code: "discarded-029",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 277,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "7c14d732782394023933ebf42822884308b91c79c2ca1a96359229b2f88376d2",
    description: "Malformed external flag",
  },
  {
    code: "discarded-030",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 283,
    column: 9,
    checkKind: "assert.ok",
    expressionSha256:
      "d73a6619eb610e5c5d02483fecdc4e7e4f6499d873db8fb08c7c81e859663deb",
    description: "Whole-scope target budget exceeded",
  },
  {
    code: "discarded-031",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 288,
    column: 11,
    checkKind: "assert.ok",
    expressionSha256:
      "158fa6a48003f9990cabf9a76f4e586dac5730287a363ea10915052a5755e60b",
    description: "Discarded target is present in an output import",
  },
  {
    code: "discarded-032",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 299,
    column: 11,
    checkKind: "assert.ok",
    expressionSha256:
      "79cb7777118d64f406156b3e57ff6bd9d6586b531e7fe2e3215575164ce35340",
    description: "Unreviewed discarded record",
  },
  {
    code: "discarded-033",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 303,
    column: 11,
    checkKind: "assert.ok",
    expressionSha256:
      "832b803cd3b148259aa3badf0af5e87d0ee1741d8848f41d23adf916d3162792",
    description: "Duplicate discarded record",
  },
  {
    code: "discarded-034",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 309,
    column: 3,
    checkKind: "assert.deepEqual",
    expressionSha256:
      "b2e0a4994d1025c1d855e8de724ebd1f830fe67fc80fa18c90ea2677e28589b2",
    description: "Missing exact discarded records",
  },
  {
    code: "discarded-035",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 346,
    column: 3,
    checkKind: "assert.equal",
    expressionSha256:
      "b1a39f9d68f6c0300829b61b9008fce1daa31921dbe7f21bf42d84a2a2fe2f24",
    description: "Incomplete discarded-input batch",
  },
  {
    code: "discarded-036",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 356,
    column: 3,
    checkKind: "assert.equal",
    expressionSha256:
      "b4319ba6ebe4766ea64b498106f4a870ac92b03263b16e983e038fd0073b6a79",
    description: "Duplicate discarded record",
  },
  {
    code: "discarded-037",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 361,
    column: 3,
    checkKind: "assert.deepEqual",
    expressionSha256:
      "7a9991ca7ed7f754413155e47bc645b0b82e3c49a96498629a97d0c832cc16ab",
    description: "Discarded record inventory changed",
  },
  {
    code: "discarded-038",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 368,
    column: 3,
    checkKind: "assert.deepEqual",
    expressionSha256:
      "29641190e57ec14b4a4e1fc2aaf3523907d2ce75caa1c435c6e68e4ab97a2ba0",
    description: "Missing discarded source custody",
  },
  {
    code: "discarded-039",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 383,
    column: 5,
    checkKind: "assert.equal",
    expressionSha256:
      "995d12a60a1569413db69010bd61b5bec00dd59404ee03bf8fc529d459870b47",
    description: "Importer metadata byte count changed",
  },
  {
    code: "discarded-040",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 393,
    column: 3,
    checkKind: "assert.ok",
    expressionSha256:
      "776f0cb6c34d836a4a6d4be885a28e3ae0c4089e85332c6e18968a3fe606ffe1",
    description: "Whole-source byte budget exceeded",
  },
  {
    code: "discarded-operation-object",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 45,
    column: 58,
    checkKind: "function-boundary",
    expressionSha256:
      "4229dee579acb1f986518e2de5d257c0c0eaadeb61d4d69b94a1543491ed469d",
    description: "Existing object helper operation failure",
  },
  {
    code: "discarded-operation-property",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 60,
    column: 57,
    checkKind: "function-boundary",
    expressionSha256:
      "9746b006ecab58b1557e3b84ae7f301b2c488a7352da68208fcac4512b342cad",
    description: "Existing property helper operation failure",
  },
  {
    code: "discarded-operation-keys",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 66,
    column: 58,
    checkKind: "function-boundary",
    expressionSha256:
      "c5f94868139582ce984925d09f0d8a9532d42066d7cacea298ce470121f06b58",
    description: "Existing keys helper operation failure",
  },
  {
    code: "discarded-operation-bounded-bytes",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 89,
    column: 68,
    checkKind: "function-boundary",
    expressionSha256:
      "8308ae145437a950dab1db92b47dece012f846c2f85c811214bbd2983e5c7543",
    description: "Existing boundedBytes helper operation failure",
  },
  {
    code: "discarded-operation-verify-bytes",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 108,
    column: 11,
    checkKind: "function-boundary",
    expressionSha256:
      "369ad8f49526a545954262be0c3d4e25528c4546bd92675df24692ec38c1c948",
    description: "Existing verifyBytes helper operation failure",
  },
  {
    code: "discarded-operation-is-reviewed-discarded-input-tuple",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 120,
    column: 12,
    checkKind: "function-boundary",
    expressionSha256:
      "ba39bc6708bbd5dd8ccd02b50fc13ab6e1f79cd82a0457531c6d6f64d73a5687",
    description:
      "Existing isReviewedDiscardedInputTuple helper operation failure",
  },
  {
    code: "discarded-operation-assert-no-discarded-input-evidence",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 132,
    column: 73,
    checkKind: "function-boundary",
    expressionSha256:
      "30965a6c039fb65dbf2a319b1999d3961a8baaf54e0364dab2176cb6adc19f94",
    description:
      "Existing assertNoDiscardedInputEvidence helper operation failure",
  },
  {
    code: "discarded-operation-assert-erasure-config-sources",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 141,
    column: 69,
    checkKind: "function-boundary",
    expressionSha256:
      "461bed70446d28394e38010343fce0dda8135f5849cfd67d618c2e623db6415d",
    description: "Existing assertErasureConfigSources helper operation failure",
  },
  {
    code: "discarded-operation-imports",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 163,
    column: 45,
    checkKind: "function-boundary",
    expressionSha256:
      "b704d4256f71c9fc23acc6bd37c55c88e053eae7cd31d562e4275965bbea4436",
    description: "Existing imports helper operation failure",
  },
  {
    code: "discarded-operation-array-item",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 170,
    column: 62,
    checkKind: "function-boundary",
    expressionSha256:
      "f7afabcaa252bbd8d935c82df5f645d25e3ee8c035bd47ecbe741ffa98ffb4c7",
    description: "Existing arrayItem helper operation failure",
  },
  {
    code: "discarded-operation-verify-exact-metadata-batch",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 181,
    column: 3,
    checkKind: "function-boundary",
    expressionSha256:
      "cb685be92cd4634426329ce02c8459451c992a5e84350b2651a960f1ed124127",
    description: "Existing verifyExactMetadataBatch helper operation failure",
  },
  {
    code: "discarded-operation-prove-discarded-input-batch",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 345,
    column: 46,
    checkKind: "function-boundary",
    expressionSha256:
      "9cfbb7af0f24933199bea84a606d25f5adfbef4b57cdeb8fe9756a646f64ddf1",
    description: "Existing proveDiscardedInputBatch helper operation failure",
  },
  {
    code: "opg-operation-sha256",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 35,
    column: 3,
    checkKind: "operation",
    expressionSha256:
      "2a7e02385dc8030818ae164948c150bc8568683cb337d31ecdea7abafadcf9b1",
    description: "Existing sha256 operation",
  },
  {
    code: "opg-operation-source-map-json",
    file: "tests/qualification/strict-gzip/optional-pg-import.ts",
    baselineSha256:
      "62d3f9c250315d02c70ce0a7bf55c2823377e923b6ad6cd17d3ff5887a1cc424",
    line: 769,
    column: 19,
    checkKind: "operation",
    expressionSha256:
      "831e28ec7ab9b6019f5d105172650a9adb34c5498f1de855a52f379538cd8585",
    description: "Existing JSON.parse operation",
  },
  {
    code: "discarded-operation-sha256",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 39,
    column: 3,
    checkKind: "operation",
    expressionSha256:
      "2a7e02385dc8030818ae164948c150bc8568683cb337d31ecdea7abafadcf9b1",
    description: "Existing sha256 operation",
  },
  {
    code: "discarded-operation-blob",
    file: "tests/qualification/strict-gzip/discarded-input-proof.ts",
    baselineSha256:
      "0608750087d86a24b30df52fcfd6f210d01cb265862ed985694481bf15571a9f",
    line: 41,
    column: 3,
    checkKind: "operation",
    expressionSha256:
      "a89418c8c039389e64d34173c97f51cf522bbff16c279ee6f0af7f6d3c958e65",
    description: "Existing blob operation",
  },
  {
    code: "evidence-001",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 42,
    column: 21,
    checkKind: "operation",
    expressionSha256:
      "8b6067d3f2bdacfb8bfe688461e07d45e5e536ea4c49b5bb43f478e3d8d03209",
    description: "Reviewed realpathSync operation",
  },
  {
    code: "evidence-002",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 44,
    column: 7,
    checkKind: "operation",
    expressionSha256:
      "f7e154253c71e38a25c482b9b9d902b2b30b74c2c38e642bbd6e52dff41be49e",
    description: "Reviewed realpathSync operation",
  },
  {
    code: "evidence-003",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 45,
    column: 7,
    checkKind: "operation",
    expressionSha256:
      "f69ab7be588d4d74697c86b472d60acfa66f12a1747d5d4b59aaf0d4b77c58cc",
    description: "Reviewed realpathSync operation",
  },
  {
    code: "evidence-004",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 46,
    column: 3,
    checkKind: "assertion",
    expressionSha256:
      "19869fbfd5de58f52027702a637a398e89142a6c292b3b8a55b45adb4b165b90",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-005",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 56,
    column: 3,
    checkKind: "assertion",
    expressionSha256:
      "231021fb1224a52aa8de585a6a456887c08520dc2cb1d1f49511e1f7f05fc709",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-006",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 57,
    column: 3,
    checkKind: "assertion",
    expressionSha256:
      "7c564675673138e1aa8d7c31511a04994f0d34ccc5f020df85d99a5784b9d1a6",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-007",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 62,
    column: 3,
    checkKind: "assertion",
    expressionSha256:
      "501110d5a3206efc3127ea98b9edbefeaf06d37a8caa5665c227462e31f9958c",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-008",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 63,
    column: 3,
    checkKind: "assertion",
    expressionSha256:
      "4e3a341b030522ad35c073a2c779c8ffdc69458ead3f357ed8d896ab4bea58d2",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-009",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 75,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "231021fb1224a52aa8de585a6a456887c08520dc2cb1d1f49511e1f7f05fc709",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-010",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 76,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "7c564675673138e1aa8d7c31511a04994f0d34ccc5f020df85d99a5784b9d1a6",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-011",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 89,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "1c6e0ef9c80a30e33f9d0b476b52094b3a8022c89e344c6cd15f995c9d2304ad",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-012",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 97,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "409b106f66e32d8f2be94aee671f06db56cf9aedd7c4901174dc09f293a9839f",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-013",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 104,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "b139ff5b21d2ace4abf5c5c7c3e09d02d5b9ab91e111051fd524dbf990bdb7d8",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-014",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 112,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "409b106f66e32d8f2be94aee671f06db56cf9aedd7c4901174dc09f293a9839f",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-015",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 135,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "ba1398ea6844e1e08e1c9201c31e466573c459131cc17b56bbd3eb4091bb1c0a",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-016",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 136,
    column: 28,
    checkKind: "operation",
    expressionSha256:
      "f7e154253c71e38a25c482b9b9d902b2b30b74c2c38e642bbd6e52dff41be49e",
    description: "Reviewed realpathSync operation",
  },
  {
    code: "evidence-017",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 146,
    column: 9,
    checkKind: "operation",
    expressionSha256:
      "a2c88f6564f91ab316e428cdac99d88ab08555c93233cd7bbe92ba8f0d4c77bb",
    description: "Reviewed lstatSync operation",
  },
  {
    code: "evidence-018",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 151,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "23f283f0dc4105eae2dd1ec39f96ecb5b33bd108379d4c4fce9659f346539cc7",
    description: "No optional native package may be supplied",
  },
  {
    code: "evidence-019",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 166,
    column: 7,
    checkKind: "operation",
    expressionSha256:
      "f69ab7be588d4d74697c86b472d60acfa66f12a1747d5d4b59aaf0d4b77c58cc",
    description: "Reviewed realpathSync operation",
  },
  {
    code: "evidence-020",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 172,
    column: 19,
    checkKind: "operation",
    expressionSha256:
      "f69ab7be588d4d74697c86b472d60acfa66f12a1747d5d4b59aaf0d4b77c58cc",
    description: "Reviewed realpathSync operation",
  },
  {
    code: "evidence-021",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 191,
    column: 3,
    checkKind: "assertion",
    expressionSha256:
      "86abb1ca549513638b737642cfef2bd84d26b27a73eafa1ac6d18b8c152f2b84",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-022",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 196,
    column: 14,
    checkKind: "operation",
    expressionSha256:
      "599e34e64c7ebc7159be966189ea0086f145c4dccd2c017daef7802313e690c5",
    description: "Reviewed openSync operation",
  },
  {
    code: "evidence-023",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 201,
    column: 18,
    checkKind: "operation",
    expressionSha256:
      "f0dd743cd1f61c7977ba4f02eb0c975eda6aba9563b88bdc8a8c0cfad38c3285",
    description: "Reviewed fstatSync operation",
  },
  {
    code: "evidence-024",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 202,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "a079e11871085e75d0385b7b0a86c96efaec7d118f83f0a3bfe778324299e01b",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-025",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 206,
    column: 21,
    checkKind: "operation",
    expressionSha256:
      "49cdfe7ff3ce2917ee4b3f4a5acb5a135eef5f6148342ef43240456aab4bda01",
    description: "Reviewed readSync operation",
  },
  {
    code: "evidence-026",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 210,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "d0681aec3927dbf4b80a5e08e7d0fcd7ea8d97e662df9b87fd0c76d2f49bf022",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-027",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 211,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "99793d2e2d9e127bf08d06dc4bb7e70442aea09e0772f0fd64093e246e79d4bb",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-028",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 214,
    column: 5,
    checkKind: "operation",
    expressionSha256:
      "61c0f756b55c1203f4d5b85c8c56439f5b0315d314124f77a8118d5ccbeaa1d9",
    description: "Reviewed closeSync operation",
  },
  {
    code: "evidence-029",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 218,
    column: 3,
    checkKind: "operation",
    expressionSha256:
      "2a7e02385dc8030818ae164948c150bc8568683cb337d31ecdea7abafadcf9b1",
    description: 'Reviewed createHash("sha256").update(bytes).digest operation',
  },
  {
    code: "evidence-030",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 259,
    column: 16,
    checkKind: "operation",
    expressionSha256:
      "e04d7546c306a76e028df6de13fc2883a01dbf9eb17add77157a61f187f17f95",
    description: "Reviewed lstatSync operation",
  },
  {
    code: "evidence-031",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 260,
    column: 3,
    checkKind: "assertion",
    expressionSha256:
      "05f734ec1f49324385670823f7d32a5a5d7773fc98efc79197ec6a58c95d7edb",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-032",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 263,
    column: 3,
    checkKind: "assertion",
    expressionSha256:
      "3169a35b5b3c2edc4cca31e229a4cd75bd0c523cda72708b10b8ff70e5a1b2bc",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-033",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 302,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "6209cfc5bce669321fe3d97dd45986b4319be8e2c5e36f54b6f488db1fb7f609",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-034",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 306,
    column: 5,
    checkKind: "operation",
    expressionSha256:
      "1b69dc23adb1d6dcc1e12f902798611964a8da0996ab5f496c043516db2bd894",
    description: "Reviewed mkdirSync operation",
  },
  {
    code: "evidence-035",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 307,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "452dbbfe31d2fc0aac0306b2f126fd7f07848829f249b1fe4f51f28859dc64a2",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-036",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 309,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "27b48466025045fac07617c554ec29d18aa76a6d74c24ee61f2c19cb95266108",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-037",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 316,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "f9f87bff8838c1553721109fed1c45a6155a3cb19a91023ce0941cd942c284af",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-038",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 318,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "03bee0fc16501b82816d98bf523ef664e30f637fa66a53c7453ad2f692ca3e27",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-039",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 323,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "444ac86d1df5fcbe28b4f3e7e7d8d3bc5f10e28943d9b68f09085d2c5cf64174",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-040",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 328,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "c8e96bd1098394d2ac92efc0113e22cf8e7ce3ab59c9da9a5df52e5069913fd1",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-041",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 330,
    column: 7,
    checkKind: "operation",
    expressionSha256:
      "633c29ff7505606f6c19c19f34eddfd0688febbac0eaddf6d92c1a4f843ffeea",
    description: "Reviewed writeFileSync operation",
  },
  {
    code: "evidence-042",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 343,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "383179770d1f504eaac6b5f364528fd5ee1b1f182fdbab9c153d21bd35f02c44",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-043",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 344,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "d860d3e395188395f55ac2f886eef48af30b897d8c0cf5c2881075ff07fc416b",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-044",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 345,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "41aadb4d344afbd4be7560d05e9a55e4340bb3b4a01955245a343a2025e3c248",
    description: "ESModule",
  },
  {
    code: "evidence-045",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 358,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "8aec1de211b6e6fa8f1c4b751da767a01d6bf77d2c32b316047731df470c3f78",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-046",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 362,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "6c6180d21b2da22aee467f09c1481010c73b4628884cdcf01b28fdde032f14f0",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-047",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 366,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "886de30fbb3a31ef759ede4a7a1a9c54f7413c5ff044372c6c93334fdd22dae7",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-048",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 369,
    column: 5,
    checkKind: "operation",
    expressionSha256:
      "efee78c6830e771005d281bc65324f0e4eacb3a6e269933e5a5f19f8ade02128",
    description: "Reviewed writeFileSync operation",
  },
  {
    code: "evidence-049",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 388,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "d8c843b6b926993d3261094f952c80e34670b75254406d1680a70c9e80215db1",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-050",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 391,
    column: 5,
    checkKind: "operation",
    expressionSha256:
      "a162818471861b40063b4c28b1956e1809d59c3f54b917ecb16f56d22fc6a843",
    description: "Reviewed writeFileSync operation",
  },
  {
    code: "evidence-051",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 409,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "de0a0463093554b37d4ed76a52d11ef13ce4a4815d95a781bb9baafebf062d90",
    description: "assert.match predicate",
  },
  {
    code: "evidence-052",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 411,
    column: 18,
    checkKind: "operation",
    expressionSha256:
      "aeccdef5d48276d19f08c3fcce12a48fff4c871dbe32b2df1e96e04c85b8211f",
    description: "Reviewed lstatSync operation",
  },
  {
    code: "evidence-053",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 412,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "c88e2624c615cf9f04c4a27fc2f877157d6f0a1b3e3d48ced56ab3b2c73da886",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-054",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 413,
    column: 21,
    checkKind: "operation",
    expressionSha256:
      "ddcf57120b4f78eebcf49edefa4f967d542f0397c04c9e1f595096e30d96f6fe",
    description: "Reviewed readdirSync operation",
  },
  {
    code: "evidence-055",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 414,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "60856b1d34180301d0924904bc173ecca56050ce5426e1ead46d2a6f5f87909c",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-056",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 417,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "1ef56e62b6b21a928d738348b60f68eb03500c82b2bd3348d8215d70cba49775",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-057",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 421,
    column: 22,
    checkKind: "operation",
    expressionSha256:
      "29fed1144f46bd423ca202bbb104e66444a73b1f378f98137f1909724c0b5de9",
    description: "Reviewed JSON.parse operation",
  },
  {
    code: "evidence-058",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 427,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "1cb213405b3e480de05206d94cd42de7fc19c2ed3f4f1e825b69967fd39630ac",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-059",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 428,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "245bf3ee5a821af5dca7da2369be8c6e9c1ea71e91c8769829cec575990f633a",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-060",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 429,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "d8005a84ccb657c7c5bf6ede56bfd018b048bb771859db06478ed748fa40a28d",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-061",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 434,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "d473349862993554a86c240ae76176ccdb72b00f7879b30843e09cdb9380edd1",
    description: "assert.deepEqual predicate",
  },
  {
    code: "evidence-062",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 447,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "f9f87bff8838c1553721109fed1c45a6155a3cb19a91023ce0941cd942c284af",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-063",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 449,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "03bee0fc16501b82816d98bf523ef664e30f637fa66a53c7453ad2f692ca3e27",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-064",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 454,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "e9ef53f652339df12cfa15ac6e3ae85422f36e5f75b26399d2f7e437f8e743c0",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-065",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 460,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "c8e96bd1098394d2ac92efc0113e22cf8e7ce3ab59c9da9a5df52e5069913fd1",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-066",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 461,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "1d2eff0c39d18df3efb718abdb17fd53a3e2c3c9fc10d7f76056592ab75411ed",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-067",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 462,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "0a87ff5d1ab9f102f3df8c77bc673261fa98f0a4093f5808cc0746a7f2f252c5",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-068",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 463,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "3ebe346e47176bad30c3d117481fe9977cfcdc6ea8132974c94f513e2ca9a104",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-069",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 467,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "943388fd3b50b885f130a838b541af56c08c588873ab717aab88af3c9baa0950",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-070",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 471,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "dad85b6fbd6c2902a5500dd375c29b692bbdc66c36fc11460320c64059dc1ce2",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-071",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 472,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "0e04ea05dd93534058e2ae5108e57f67f4627b9d379872f9cb6cd67de6cf0958",
    description: "ESModule",
  },
  {
    code: "evidence-072",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 477,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "8d04102a406ca2006213a60728971aab7179d5b5793171add7dc7688d44447d4",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-073",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 485,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "2331935c871a16c094b0251c3f005cd30171c76396fa057ac73aca89ce526dfa",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-074",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 487,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "1903281e4e8f5b1f8415e806b78218488d632d00b59c36097dfac33f9072824d",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-075",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 493,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "5489ecf0c0010d7c2ec0552b1e6d8fcc2e260e6ae4dc70f9e1f581bf28d22aca",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-076",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 504,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "746a73fbc658d016c56a7d2fcc037f8e291d95144cd632a61dd6e7f6229e4c05",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-077",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 508,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "668704f4694fba88b657c7a0dee7502e3956a88ab8f5de6d62710622cd7eb8a4",
    description: "association.bin",
  },
  {
    code: "evidence-078",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 513,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "79dd551f06ce54ba84bb32bf951fb487237467133b6fd4739f3ea12fc2061d09",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-079",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 514,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "9625bcd3596a59859b4d0ca22736293f63e6a395524d2d64b824f12b9c09fd30",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-080",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 515,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "4eb2bd37f9c186d2da5c1b0f5f69e2adce9cb4ff5ece2c747c31879cab4dbb9e",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-081",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 530,
    column: 18,
    checkKind: "operation",
    expressionSha256:
      "809215642ad97ab911e0e1879c309179b34c1a5932daa83d28ee2d4a13307e5b",
    description: "Reviewed JSON.parse operation",
  },
  {
    code: "evidence-082",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 533,
    column: 3,
    checkKind: "assertion",
    expressionSha256:
      "28d6028dd791c6d099dde295d8f60b980bf54c2901a3fd716a6bde4a9c6541b8",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-083",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 534,
    column: 3,
    checkKind: "assertion",
    expressionSha256:
      "5f8b8482a7cda0a70717436897287c294a594a17cc8beffd743336ae479b5dc5",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-084",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 535,
    column: 20,
    checkKind: "operation",
    expressionSha256:
      "6286a443b4561c7f8221517a730a8a872936f32d24047269633cefb77d83f409",
    description: "Reviewed realpathSync operation",
  },
  {
    code: "evidence-085",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 546,
    column: 3,
    checkKind: "assertion",
    expressionSha256:
      "2650712183894fe506c7010b4c9ddadbb79c99b86214e0af09cee6e8cf3aaa3c",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-086",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 547,
    column: 3,
    checkKind: "assertion",
    expressionSha256:
      "c9bf4644bb012eea4d08a85fbdc84f1d6e38c8473246a8e3808a05760914a71f",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-087",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 548,
    column: 3,
    checkKind: "assertion",
    expressionSha256:
      "8cf101aa69c86a406bb9ce9b9ee2df83744604cb0811c1d1178123f8cab70cc4",
    description: "1.20260730.1",
  },
  {
    code: "evidence-088",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 549,
    column: 3,
    checkKind: "assertion",
    expressionSha256:
      "d09b2067b9d6d20249d21d2eb70797b6dcf7318a6683295128f9a579851b9c51",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-089",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 567,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "05cfe2d3aad10665b71691433913ff37c210ee2fd235c8c4c6924313e6c620b9",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-090",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 577,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "62c02847d1a8ecb1135a15b15f6de4ef78ca25070be6915ef140fb87b2751e27",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-091",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 578,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "3d9f178bebfe1d6908b4cdefb1a7be2877f4dfd255f3ca57b3b09270f7335728",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-092",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 581,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "ce559aeeb21dc8ce83182f79f5268c62f6c4ce1c5236a1a0be5c1363a6c9b2b4",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-093",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 582,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "171fb2ae5675707e3e72bf3fe44e6fbb3985149158c4509ac1fe0ec7e72d96b4",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-094",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 594,
    column: 11,
    checkKind: "assertion",
    expressionSha256:
      "1e3999096f185e17d5d606410a448632645703c7bd2fa94709a1830a3cbf50e5",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-095",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 606,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "2818c1250edd69cc86f410026d05f11265204bad29caec635b3e822abc5b012d",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-096",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 608,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "44e537cec5a91ea0552bc2f98f347c378e98a60d81a259f363e4d9c7cd7bc78f",
    description: "assert.match predicate",
  },
  {
    code: "evidence-097",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 609,
    column: 20,
    checkKind: "operation",
    expressionSha256:
      "b99ab77de5497d5e8d1b9e89006704498627d25746cbd4379c66e995a303902e",
    description:
      'Reviewed new Response(new Uint8Array(bytes).buffer, {\n        headers: {\n          "Content-Type": `multipart/form-data; boundary=${line.slice(2)}`,\n        },\n      }).formData operation',
  },
  {
    code: "evidence-098",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 615,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "fdd2f69fc37ed0a42b5c057e29a2ad2073b381a9b925eafcb876904ecff31931",
    description: "string",
  },
  {
    code: "evidence-099",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 616,
    column: 20,
    checkKind: "operation",
    expressionSha256:
      "995ac7cae029fe666ee2a41841e3d3446c094e9c5e0f7d5fc75b364c0681cb55",
    description: "Reviewed JSON.parse operation",
  },
  {
    code: "evidence-100",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 617,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "93c6368fe1e9645ce6fd881621de33d969b40264f64b84ba45e72d1aa79d5e09",
    description: "data-api.js",
  },
  {
    code: "evidence-101",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 618,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "8e844bf11eaa35435c382cff4513d63b4b6d96580f86ab254394fcea90c132c1",
    description: "2026-06-06",
  },
  {
    code: "evidence-102",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 619,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "bda07072ca7b1204db9d796bb7b9f7f8f3972b3eaee51657389529177cb0a732",
    description: "assert.deepEqual predicate",
  },
  {
    code: "evidence-103",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 632,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "11b0da4df63df23b5b8c3fa7fc6f44aa6c7b770c586fb3416e3e12a401580c35",
    description: "string",
  },
  {
    code: "evidence-104",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 635,
    column: 11,
    checkKind: "assertion",
    expressionSha256:
      "27b62a94a7aad1a8002c22b999b0bd89612c17be7010deb138e9ecbae6dcf449",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-105",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 636,
    column: 21,
    checkKind: "operation",
    expressionSha256:
      "24eabb1cd2172c6cf500ecefd3d83f50ecd4bfcabb3088a9b183b0309c530c70",
    description: "Reviewed JSON.parse operation",
  },
  {
    code: "evidence-106",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 639,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "d5879e9a4453186592543e67a3821fc8bf6765dee6e12f788b2d539f95da1f48",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-107",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 644,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "cc4b7783d67892085feccb72715c3234f9bcd269fe7427e5342a2460476ae480",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-108",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 645,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "2c2928d967981abffa546788d05f757cb1f0d027e2a2ca626dbd37ed01dea652",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-109",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 646,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "7309cc8cd955b65762a4391342d81f039a45203c6e8e260a6cee774e8e926529",
    description: "assert.deepEqual predicate",
  },
  {
    code: "evidence-110",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 651,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "e27a4a554b5403778470aa42d6f5d9142e1263635afcb4dd02343da5f8082bbf",
    description: "assert.deepEqual predicate",
  },
  {
    code: "evidence-111",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 656,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "a7b12f6609691035260d562298041f9176e3a8246594182b9e37158c0b56e13b",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-112",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 664,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "474f825eea7da91f4936577181a90add33eb20a296a1c4999cbf1f2482998afe",
    description: "Required genuine bundle source association missing",
  },
  {
    code: "evidence-113",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 677,
    column: 25,
    checkKind: "operation",
    expressionSha256:
      "8179c693d541036423ccd1c634652112f295493e377dbff40a1389dedf68e1a9",
    description: "Reviewed JSON.parse operation",
  },
  {
    code: "evidence-114",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 678,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "81779d4b69a45df79a053d8f8bab3a48e9074842b822cab62d0078e923c4ce06",
    description: "esbuild-api",
  },
  {
    code: "evidence-115",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 679,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "61944fc8b1088f9f5cbbc851dce48fec43eb80afb09b1b2f3f4fb20ed16500c5",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-116",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 680,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "670ba460e39e6a22708743bd76ab6ac27dc1bacb3e73e593056dc6a766212864",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-117",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 684,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "119d51b07ddd5e2ac953339778a0556ea177aaf149dec3789e1f749213f4cc0d",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-118",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 688,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "32d4d080dfd23c26d08d95ab21cefe95921fe92a4abe91383e74fbab042cebed",
    description: "assert.match predicate",
  },
  {
    code: "evidence-119",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 692,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "61b73b19b7735d4bf294bb24e099395ddd58e3e3a150411b5de7e8b5a9c19fd6",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-120",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 695,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "39d334fa9f2ad4e4da16229b795c953df030f567adce5d7803494b093fde437e",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-121",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 700,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "8c5e7ef225c6ff1517290fd7df0dd799c79814378b5cedf023e331a1d91196aa",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-122",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 706,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "707ac925b1b57cd4d576dd973942ef4b98d8d69bace3edcd1af21425317bf62a",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-123",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 712,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "3bf58e726901ad8f990612d9320ae19479bb891d0aa83e1f72a0b3382cb7cab5",
    description: "assert.match predicate",
  },
  {
    code: "evidence-124",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 713,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "261146433aafcd6bb4ac4accf8263a05786ef657ee5525a2e7658337dc0c1276",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-125",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 721,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "16631dc0d6d979674f266132e0a61a0a007914fe4a87248c45bebc0a6508ea3b",
    description: "Duplicate input identity",
  },
  {
    code: "evidence-126",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 723,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "262ebba213ce1ed1e284f16409ed8ac2d1516950903cefa03825718e5e84e4dc",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-127",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 724,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "b4ce3cbf69f71e28f515d93241be4ceded8b77da44066f0f81e92925112bdfed",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-128",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 734,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "86498dd87c46dd407b977382d338509376f79adc0a1028475d21d0ba0bc1a712",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-129",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 737,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "a999db867b5e6cefc4f94425e5e825f82180295bd07df4db9c80035fbe1097c5",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-130",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 740,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "540e010c1bcbd6e65afbe5e24e09b195bde862b30679d1450119a3492bda1547",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-131",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 745,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "1a66783a73f0780fa72a0e61dd0b4d3b4a1830d6b815bceaae33391e16bf9570",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-132",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 746,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "c42a5c888fe6f37885352b72eee0ab5c57616450c78d7aaadb12acd2151bd979",
    description: "string",
  },
  {
    code: "evidence-133",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 748,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "63e34698d8e7e1fb2ef64fec6bf92589ab6db96108da5a7a3ae5cb55dec69c4b",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-134",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 749,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "0ad9d44723d29f80ee6b8d8d2ff6c14e64b48bd14337fd96f3b9bf139ae0aa03",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-135",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 750,
    column: 22,
    checkKind: "operation",
    expressionSha256:
      "e25838085d087e4c29adff5a9b949a31f68db9c47a903463b5404b60ceefafc9",
    description: "Reviewed JSON.parse operation",
  },
  {
    code: "evidence-136",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 753,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "1a5e8b2547ce77612a8a04a5cf410d0a01ccdaeeb307d3a51f94b5b59642b3b4",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-137",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 774,
    column: 13,
    checkKind: "assertion",
    expressionSha256:
      "cfe9e5bd7367e0954bd7a0e5546d2134d96fda90a841ff272ba2c5af60781327",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-138",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 776,
    column: 13,
    checkKind: "assertion",
    expressionSha256:
      "720ac576facfa3ff753b9263c28d4f72b45f316d1453b768e512dc5259fcec6c",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-139",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 794,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "952645c55409be863510bc4998c1c39c98230beced17a64ca7c9c65fee17f130",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-140",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 796,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "bf84d693003f2b7acf1d653e5012da26b32740b11a5430d555ceedba8e539b16",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-141",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 798,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "4757aa08ed8c90236b938b830ebf7d39a5940c990cdd88ba7ab798ab3a747229",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-142",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 800,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "763429f3df3dc6d146901444e049f4b5b0f658f28490e4ebf09f7fe14340f1b5",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-143",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 801,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "124795837f492a863425060948c77e4e7db09334c86e02627ef95d18f59bf787",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-144",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 805,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "55e9d893bdb74e11c474bd9918b9a66f2803709fbf7efab5c599ba0ef2739cb5",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-145",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 811,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "8a489047a713f62d0c3eec591d83fb340e5d158b95703ddc31adba317f7433e2",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-146",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 815,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "d3e6a897f7e8e70c09660b7c532826e77620aa1c2d2e20b529acb60f327b26e1",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-147",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 816,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "3020f4d43cb983410cbbc05b02bf31d68bc9bda31fa4eecdfe26496dee287736",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-148",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 817,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "044c46342204c856a1ed755bb351d56f8929703eb1322958d8d01959db059837",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-149",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 818,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "18906842aab524171dfcafbc8f96db5d6689742699da1d853f2ce8a5b81fd139",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-150",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 820,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "12fcca5e46845a191960bf407015e20ea069cb0b24fba54d310af898bcc736ce",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-151",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 821,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "5b001876ba8b15a96a8b46b5f669444a8df7cb7fda77f220d8f0826f6c3f807c",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-152",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 823,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "124795837f492a863425060948c77e4e7db09334c86e02627ef95d18f59bf787",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-153",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 824,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "393bc83c18af91fccfa0ec7caa094ad7a9033b038abc47714660cd424f3a15bb",
    description: "assert.deepEqual predicate",
  },
  {
    code: "evidence-154",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 829,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "6a159c7ffdd78cc0a8005960d521e8e4f3c05efb40302dd2098723edd56842c0",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-155",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 853,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "9fd0892ee1786caebf1d08992d5d812aee9c90088a8467c5b7757dd2cb14f7f6",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-156",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 861,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "79f053a14f3dd2f0569fb5dd969c936b677d2a6eafc787b2263e16ba54910ff3",
    description: "assert.deepEqual predicate",
  },
  {
    code: "evidence-157",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 862,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "9567731f28b5f3791b5df287f90b71730ad8565f4e0fbcd59c28cdbc23b5c2bf",
    description: "assert.deepEqual predicate",
  },
  {
    code: "evidence-158",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 871,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "e448457e20d73f109d1647c2e513b022bc49fedd93d872e39e32664598cb1c9e",
    description: "workers/api.entry.ts",
  },
  {
    code: "evidence-159",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 872,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "5c413238bd10f16355cdec9c0077fc76765be3cb4bc201265fa69298e6d0e7da",
    description: "assert.deepEqual predicate",
  },
  {
    code: "evidence-160",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 890,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "d694885616d0d9c41cc34e8827ed96e6d666f2ba5d438b2330597d20ff63210a",
    description: "assert.deepEqual predicate",
  },
  {
    code: "evidence-161",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 906,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "04dc39c8d13df1cdb76e32be4cc4ec19ae86ad032dce89e4c8be0935dee6785b",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-162",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 912,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "82aee6562fb7860a64eef41b12ede1542acb3616cabd25f8f62d4e20f6483d87",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-163",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 919,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "cfe9e5bd7367e0954bd7a0e5546d2134d96fda90a841ff272ba2c5af60781327",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-164",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 926,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "3cad19faba61cffc98a893b74ed29e1005d10024dddbd236da0c9f60dcb34e92",
    description: "assert.ok predicate",
  },
  {
    code: "evidence-165",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 928,
    column: 11,
    checkKind: "assertion",
    expressionSha256:
      "fd45a729ffebe6fbc41f50245c4eb3540e41312a2e3bc6a04a250f6d39d9473c",
    description: "assert.equal predicate",
  },
  {
    code: "evidence-166",
    file: "tests/qualification/strict-gzip/owner-build-evidence.ts",
    baselineSha256:
      "4e6327ddd9e06c0ec71ab96d0cabe1fb084fa9127ea8e33f6b6991dadb222633",
    line: 937,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "4ea95f51827b966e6ce31604bda9518eed12f3ed16dc1192480b9864ef25e3b6",
    description: "assert.ok predicate",
  },
  {
    code: "raw-001",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 102,
    column: 3,
    checkKind: "operation",
    expressionSha256:
      "d99360091785b47f70ecedecce74027e3939c7c87c6c408818073494ea980d37",
    description: 'Reviewed createHash("sha256").update(value).digest operation',
  },
  {
    code: "raw-002",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 107,
    column: 19,
    checkKind: "operation",
    expressionSha256:
      "a863740666f81623f2dd6e62b7d16ab75b73048ef4b9aa0d8364f793dd364a19",
    description: "Reviewed readFile operation",
  },
  {
    code: "raw-003",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 108,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "df7fd148b5fcc42e0ce809c244ab8ea9c861cc688c6a158ffa55ebff1582d27f",
    description: "assert.equal predicate",
  },
  {
    code: "raw-004",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 125,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "fcf922226f415920e0b2e0855fe93f23c4d7d3afa2fba9f62882b39cd61c779c",
    description: "assert.equal predicate",
  },
  {
    code: "raw-005",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 128,
    column: 33,
    checkKind: "operation",
    expressionSha256:
      "c7dffff31df190c35792fc1846b0e603b28d95e24f4f767f599223afc9784695",
    description: "Reviewed dynamic import operation",
  },
  {
    code: "raw-006",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 135,
    column: 21,
    checkKind: "operation",
    expressionSha256:
      "a2cc244e5d95934463d95ae936d6add608948a9d71f70940e81d561c5d58f75f",
    description: "Reviewed dynamic import operation",
  },
  {
    code: "raw-007",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 138,
    column: 16,
    checkKind: "operation",
    expressionSha256:
      "7a75e2432ef141ed16d8594fa9ecc15a5b6072eb448f867a5a68a02c3ef2bb3c",
    description: "Reviewed buildApiWorker operation",
  },
  {
    code: "raw-008",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 142,
    column: 7,
    checkKind: "operation",
    expressionSha256:
      "be129d94cfb2f7eaa63e43c1127a24490ed427efd2fe928001569fd1d400914a",
    description: "Reviewed esbuild.stop operation",
  },
  {
    code: "raw-009",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 145,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "07dd27dc18e3de5219dd9396c1003a1129a650ccb06e9f51e7fa7ee192eff3d7",
    description: "assert.deepEqual predicate",
  },
  {
    code: "raw-010",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 146,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "0c8cb2dc76a4562e55422d12f7e13583f1c41037ebd0f3e9ebd12dc006fa7cb8",
    description: "assert.ok predicate",
  },
  {
    code: "raw-011",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 148,
    column: 24,
    checkKind: "operation",
    expressionSha256:
      "3d82c619dce6e770317f34ff4b89d03f4d3f412cd13b82dc8c79cc11fa68cd05",
    description: "Reviewed realpath operation",
  },
  {
    code: "raw-012",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 151,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "02afdc6efd4f4165a5c4619092b1ddae5c9df74001fa7909b89b3ed2f057445f",
    description: "assert.ok predicate",
  },
  {
    code: "raw-013",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 152,
    column: 27,
    checkKind: "operation",
    expressionSha256:
      "d9651292035dac7e2f35db3b8cb494449a102f416bac0a291af50d394cd92b81",
    description: "Reviewed readdir operation",
  },
  {
    code: "raw-014",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 154,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "5f3f1a36c3823bd49da99668d9a9cd309dd61af0c094232c27e22875e09b5f5c",
    description: "assert.ok predicate",
  },
  {
    code: "raw-015",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 159,
    column: 11,
    checkKind: "assertion",
    expressionSha256:
      "37ab335fa08351037653b130d6915aa058ded19274139d9d802296ddba137656",
    description: "No output symlinks or special files",
  },
  {
    code: "raw-016",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 162,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "b79f802ece8d983b074ee8215d8b5050170ef98a354146afd6e9244290098e21",
    description: "assert.ok predicate",
  },
  {
    code: "raw-017",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 173,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "ec4247c3482f254dc2c531c77da85b7aa21173a6f2156385f737ce6a0458eea5",
    description: "assert.deepEqual predicate",
  },
  {
    code: "raw-018",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 180,
    column: 21,
    checkKind: "operation",
    expressionSha256:
      "366d38b8c8b9c00ba1121bf841a917a2dff73e58f7993613475eb82100eb8fb0",
    description: "Reviewed readFile operation",
  },
  {
    code: "raw-019",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 182,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "572ee13364e3281be3a58fb0e51e45e4edcee72fea3fec820b4b5ce93bdbcc14",
    description: "assert.ok predicate",
  },
  {
    code: "raw-020",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 185,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "1c569e3aea4aa38e82295f174219a52480cc704533b23f61b4ab7e3157288d2d",
    description: "assert.equal predicate",
  },
  {
    code: "raw-021",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 187,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "29becea3b4894105dd7c54281f9da9740d0dea53a98c7670f8fd9fa21799f824",
    description: "assert.ok predicate",
  },
  {
    code: "raw-022",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 192,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "50b8b698bb0feb8f194dc6065fc85df86ad65cd0c19c3b8083742e2856138e8d",
    description: "assert.deepEqual predicate",
  },
  {
    code: "raw-023",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 225,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "00f6b80d264ff222c35b6040b51a0486f307b76485fa459c7b317384ced30b75",
    description: "assert.ok predicate",
  },
  {
    code: "raw-024",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 226,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "8e3a2b1fbde0017bfa8c91720b7f16f81b8e26c3cf126f135a4ea0637d263600",
    description: "assert.deepEqual predicate",
  },
  {
    code: "raw-025",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 248,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "9fd0892ee1786caebf1d08992d5d812aee9c90088a8467c5b7757dd2cb14f7f6",
    description: "assert.equal predicate",
  },
  {
    code: "raw-026",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 270,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "de6b6cd8e835feb8c56d55e37811b13a38e22da61214367e54c66d27b8cd3275",
    description: "assert.deepEqual predicate",
  },
  {
    code: "raw-027",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 277,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "fa9774707f7db4e688c67b61803103d70ecde99f17ff9b261710880bc364fb44",
    description: "assert.equal predicate",
  },
  {
    code: "raw-028",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 289,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "8942422cde0f83478e0a12a0555478729e06c0581f9a30a511aad91fc86de51b",
    description: "assert.ok predicate",
  },
  {
    code: "raw-029",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 291,
    column: 9,
    checkKind: "assertion",
    expressionSha256:
      "fa2a0453b0a99adffb68f1094e7602f67980e5121b6811aae1a9cca2dff316dc",
    description: "assert.ok predicate",
  },
  {
    code: "raw-030",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 303,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "5b9d5b7d34496f860a6578dc7c059c59f83105f2cd92553d8a6ed521a13cc99d",
    description: "assert.deepEqual predicate",
  },
  {
    code: "raw-031",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 304,
    column: 27,
    checkKind: "operation",
    expressionSha256:
      "ef5effcb8b88dc4afa7320e614e60d4e0ac28e78ef3170959995d6c2aabaf754",
    description: "Reviewed realpath operation",
  },
  {
    code: "raw-032",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 305,
    column: 28,
    checkKind: "operation",
    expressionSha256:
      "24305c3784ed7fdec817bbeef8596ac4843f148ccc07c656e77f7819f5444a3a",
    description: "Reviewed realpath operation",
  },
  {
    code: "raw-033",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 315,
    column: 7,
    checkKind: "assertion",
    expressionSha256:
      "d939f50891e7467272c2b55c13d9f8b8dd64a8490ea2d37bed0371b87e14d732",
    description: "Duplicate raw input identity",
  },
  {
    code: "raw-034",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 333,
    column: 11,
    checkKind: "assertion",
    expressionSha256:
      "46040679fc60c927155a9de352f27e623f4c8e73ea5bc7ee07b0d90013a3cb97",
    description: "assert.ok predicate",
  },
  {
    code: "raw-035",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 341,
    column: 29,
    checkKind: "operation",
    expressionSha256:
      "366d38b8c8b9c00ba1121bf841a917a2dff73e58f7993613475eb82100eb8fb0",
    description: "Reviewed readFile operation",
  },
  {
    code: "raw-036",
    file: "tests/qualification/strict-gzip/raw-owner-fixture.ts",
    baselineSha256:
      "7267e05b8a119951d60f6358a97a9253557e8a6d53eaf5430700ee70a7db6f26",
    line: 359,
    column: 5,
    checkKind: "assertion",
    expressionSha256:
      "d128e55ba45db46dfd078ed9958b02056738d86f9f6dd74f794664c5906ffb1c",
    description: "assert.ok predicate",
  },
  {
    code: "pg-source-001",
    file: "tests/qualification/strict-gzip/owner-pg-identity.ts",
    baselineSha256:
      "1d5bc2c823211349b2744f054b14fc0d77f04fa7c60537b959dfc01ba25d9498",
    line: 22,
    column: 3,
    checkKind: "assertion",
    expressionSha256:
      "f322450335420e7289e8b098d135b2ba823c6cc4f6e10d0b6ff93593712db94f",
    description: "assert.ok predicate",
  },
  {
    code: "pg-source-002",
    file: "tests/qualification/strict-gzip/owner-pg-identity.ts",
    baselineSha256:
      "1d5bc2c823211349b2744f054b14fc0d77f04fa7c60537b959dfc01ba25d9498",
    line: 23,
    column: 3,
    checkKind: "assertion",
    expressionSha256:
      "0c918bd40002cea25e2b51b97fc7298b9ad1f8d9bd223a10946796b0acac4387",
    description: "assert.equal predicate",
  },
  {
    code: "import-policy-001",
    file: "tests/qualification/strict-gzip/owner-resource-policy.ts",
    baselineSha256:
      "22e9d95443d84ba57c7e33dc3758b7435942a3686df7fff87281cc7c0859ebb5",
    line: 36,
    column: 3,
    checkKind: "refusal",
    expressionSha256:
      "f7b5c116105f5b7f16b55ff9977d652de1c915b8faf9fd51b21989b5c9cd9097",
    description:
      "External import does not match the existing builtin-only allowlist",
  },
] as const;
export const OWNER_PROOF_REASON_REGISTRY = Object.freeze(
  rows.map((row) => Object.freeze(row)),
);
export const OWNER_PROOF_REASON_CODES = Object.freeze(
  rows.map((row) => row.code),
);
export type OwnerProofReasonCode = (typeof rows)[number]["code"];
