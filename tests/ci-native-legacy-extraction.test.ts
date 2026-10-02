// Temporary remote-only release fixture extraction; removed before release.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { test } from "vitest";
import { readFileSync } from "node:fs";
import { decompress } from "fzstd";
import { TypeRegistry } from "@polkadot/types/create";
import { decodeNativeMetadata, unwrapNativeMetadata } from "../src/native-runtime-metadata.ts";
import { format, resolveConfig } from "prettier";

const releases = [
  [
    "v1.1.7",
    "e6683abcdc46e24e4739d087614e88b19a03fbd0",
    "sha256:7b7969dcffe0e1cd1d81bd257ad69a4ba026749a350e9f6195f35c7999fd6f97",
    594914,
    "81d41028ad198a49d2fc8d93db985ed02ce95003a660d87453ad5fef1b6cd04e",
    "e6683abcdc46e24e4739d087614e88b19a03fbd0",
    205
  ],
  [
    "v1.1.9",
    "4e2c494cd089de268a4c4169f34c1754190fd9ba",
    "sha256:47df99ecbf8b159089bb8987e39898c294faf3518ee865c093766ff03790fb4e",
    837078,
    "1a38b7c84acacaf4e6915adcd38f197198bd29be0fae2d5afba3b583ee48d03b",
    "4e2c494cd089de268a4c4169f34c1754190fd9ba",
    210
  ],
  [
    "v1.1.10",
    "44d6859723fdd977e6c0928ed7ea99b1e354fdb3",
    "sha256:45b7bbd7cb9401091dcdf72fd599c07d751c81f46cd598674221fdd85ec0cc95",
    836799,
    "dd41463d6ccf202327ae0f3aaab155959e6bc98d7b6ab6edb57e784c4c4c2c4a",
    "44d6859723fdd977e6c0928ed7ea99b1e354fdb3",
    211
  ],
  [
    "v1.1.11",
    "7364b184cbed523f4184e9db35a2cd9ea23afcca",
    "sha256:03fae0ac88fb78839fc0c48f037f708c60ac456c8b500e76f482c760b29e1c35",
    836800,
    "34cd1bdae2d176d30910b762b907f355496df775fe52a595e86735d67453a968",
    "7364b184cbed523f4184e9db35a2cd9ea23afcca",
    212
  ],
  [
    "v1.2.2",
    "205025194588599fc21a2af7e63356a3072a3a21",
    "sha256:83f33594b0c859c2e37fb58f415841b61acf707ce235027b0f386da40541218c",
    980351,
    "5bc71c20754ee3a6ceb619d15da98c43e4a436c4d9a4cf567d75163a44b34cd1",
    "205025194588599fc21a2af7e63356a3072a3a21",
    216
  ],
  [
    "v1.2.3",
    "c1c25e28d44dea4a0062628a71283760839cbd00",
    "sha256:5fd585e0e59694c5b4c7aa3830ba582e7d39c90a7dc446684ed3d79f1dbff414",
    983621,
    "10a2b3267ea7f0bba621e3adeb5096ab13158da13ec154c2369f32b6c8d5e519",
    "c1c25e28d44dea4a0062628a71283760839cbd00",
    217
  ],
  [
    "v1.2.4",
    "d4d8182eb99c564d707c81f65f1236c33ccda24b",
    "sha256:7a3e3ded528a5b4c0d08f4633f8c7f17bfd8aad856ded8e023207593ec277dd6",
    984116,
    "6f512cef5d6385c0df1795f326645c2260cdc03a6928f684d9ca258498cb5444",
    "d4d8182eb99c564d707c81f65f1236c33ccda24b",
    218
  ],
  [
    "v1.2.5",
    "8f39a58329f2d195f029793942d1de3388b3edeb",
    "sha256:5af5fa7dd3d21e54281367cb3a991cf56b4d5cb6128bfff810bac09751748066",
    984108,
    "0af9215c50e1883d284471e77164fa0d392fd56fec70f15c2db31d782b2cbbe3",
    "8f39a58329f2d195f029793942d1de3388b3edeb",
    219
  ],
  [
    "v2.0.0",
    "de6f5b05b774cda2d5f0ab10dc05cf2ee25886cd",
    "sha256:d233ebf53f8fc84d1b5580675fdd81a5f098c232651b3c834813feb719d05834",
    1047605,
    "fe8c77cb3c72fffd40a9b6363efc2d91de5203af8e85cb3243dfbeb0246579fa",
    "e2b8367b8be2d9ce60ae5858c49138fa05f44a68",
    233
  ],
  [
    "v2.0.1",
    "f95810a25d8b7f402189c9b39e1d73f8a4e4f90a",
    "sha256:743450cf10260452571ed87d685b7d0ed979f0ed71a5fccf7012a7f663a9e9f3",
    1047608,
    "34aa0aa5d5f5179939358d433ca30ebf471d562215e13ad25c6169aaef66eee5",
    "f95810a25d8b7f402189c9b39e1d73f8a4e4f90a",
    234
  ],
  [
    "v2.0.2",
    "f9254ea63c72586270700d0edc0e75804404ba4c",
    "sha256:85b2f978ab66941f20a352ffec28809933eb8911fe79e62ed61869fb349f8c41",
    1049397,
    "b34bba8e9bbe56a24fb119bf862f7adb9557f61402338c52aeab724dffb934f6",
    "f9254ea63c72586270700d0edc0e75804404ba4c",
    238
  ],
  [
    "v2.0.3",
    "85f72d9dc4773f82019016e770238a44a89b8185",
    "sha256:8ceb880a5c3183b1325c4fece8e696904669640f11e60697d1d95f8fe5057950",
    1049874,
    "fc707b907e94d4b4346ca75f75208d4d569159d35b96466a0f1e4638dc66fc74",
    "85f72d9dc4773f82019016e770238a44a89b8185",
    239
  ],
  [
    "v2.0.4",
    "5974aa9ab8ff3d3220575166b529b98c8cbbf533",
    "sha256:27b6e9cc0e044080c0ba2cff9386a00274ea306c7467c374fe6d616920e9ce05",
    1083973,
    "2410e0f49a20cc1264748958711c241db770970c476a9f7ba5eca6fa8c078113",
    "5073ade602c367471f5124329b9d7ccf8e972d69",
    244
  ],
  [
    "v2.0.5",
    "17b6ef3fe3a19809b48f278ab306b5bf0064b95f",
    "sha256:852ab02cdef3f71819402065cac3ba788942cc362417f31a4fb6472424de2e30",
    1079521,
    "07e91c4b5d5e9e659a8d6a3c80d443fa9900bc995dabdce2f4a688d54f0d85c9",
    "17b6ef3fe3a19809b48f278ab306b5bf0064b95f",
    245
  ],
  [
    "v2.0.6",
    "a27fff2918adab7dbe9da19c08657752698989da",
    "sha256:42fdd20209c3fe896f7751d0a023d82203c4591687b62fee1601142f0a53d240",
    1079839,
    "fe9ebd27673adffcd2fd7f96c7460e08919fa75e7da76a8938d5198c2135a85d",
    "a27fff2918adab7dbe9da19c08657752698989da",
    246
  ],
  [
    "v2.0.7",
    "27de7d5f9266a75cf6c603757a8556ba5b9e5011",
    "sha256:c77428460c51e99369995eb53fed4be3682e9b57023c6cdcbfe9ab78d423e832",
    1084723,
    "c8a50d999d26ab92575df25a3c9734d2df673299212fe5bd110bf4dcec923015",
    "27de7d5f9266a75cf6c603757a8556ba5b9e5011",
    247
  ],
  [
    "v2.0.8",
    "b61dd30202ff6e970a18b5a5231b62183b6ba972",
    "sha256:d3c83b406d9e10389ae672c01d34db662134be8f395235d803abf77bc3d86a7e",
    1093509,
    "8bdedca7eaa9fe19484f90302effb88cd1c68c6e479cce03d5a5cbeff8184454",
    "b61dd30202ff6e970a18b5a5231b62183b6ba972",
    252
  ],
  [
    "v2.0.9",
    "8de0d23ca7dc94f5d4c595626f126ec6eb63dbb6",
    "sha256:5dd8667903ef009b157fbba0dbba14b5081b5f5e3077e43955bafed1ae87827f",
    1119765,
    "08759cad2c25a41e384d6fb6551b96c11a781e0a9064eb63737ad6e9121b8f62",
    "8de0d23ca7dc94f5d4c595626f126ec6eb63dbb6",
    257
  ],
  [
    "v2.0.10",
    "719a6f5e9ecacd0e9cd95d5d7d190f9c2021d75f",
    "sha256:724680e445346026202f96cf2bdd0856161b9c60833ff867ed2d6312fd609a70",
    1119786,
    "b0c0cd0b6072e526236582d14a84f03c51f8dbd6df990b793edeeb869f8209ea",
    "719a6f5e9ecacd0e9cd95d5d7d190f9c2021d75f",
    258
  ],
  [
    "v2.0.11",
    "6b86ebf30d3fb83f9d43ed4ce713c43204394e67",
    "sha256:bde363b03b7ffaa33ae27a098b90c344049a4d72ef297e42d325f8e58da160f5",
    1163848,
    "7ffdd9d78e47118f188debfef9f46dd429f0c4e683e78e6239bc5327704a64a7",
    "6b86ebf30d3fb83f9d43ed4ce713c43204394e67",
    261
  ],
  [
    "v3.0.0",
    "a1bf521444a80c86c37f1573af2e8860700c0b79",
    "sha256:485f3c523c70e008ec6ab9f92d74ec456160f3ccc5f2cd487688c175d751396c",
    1164191,
    "3486eaebe3f06e58623d8997125f0c27cbf09bbc881f1f8933a5092234ecdac2",
    "a1bf521444a80c86c37f1573af2e8860700c0b79",
    265
  ],
  [
    "v3.1.0",
    "1b0c63a71251e2ba68cc6fdd8ff40566c952b802",
    "sha256:90d44f5d0419c07ca79cb435167f7f4cc4fb7f5f0103444e9b6d14ee192b1de8",
    1197153,
    "49f82018036fabb0c0e4c81de4ee602ca19bcd724d98c706fa9f5a2d97cf9565",
    "1b0c63a71251e2ba68cc6fdd8ff40566c952b802",
    273
  ],
  [
    "v3.1.2",
    "4c9836f8cc199bc323956509f59d86d1761dd021",
    "sha256:f3f1d440032690cc1a74134b2a3a2f5e2b9189b45075a871bf5ee19955b987bb",
    1197243,
    "eb95a354021054ce3740cef2d78524e5fea6eabceac81a9de1839bc3015b08a9",
    "4c9836f8cc199bc323956509f59d86d1761dd021",
    274
  ],
  [
    "v3.1.3",
    "0e9f293d076713885a4efa996eaf52f24a45ae57",
    "sha256:69f12ab11f101d6ef961ecc1e850fe6df6e3fc2b39a9bfdb31cfed3d997e9b57",
    1197890,
    "f8924170ae227e98117b883fcbb173124ed3ebaed10cb77c1bdacd6bee3f221a",
    "0e9f293d076713885a4efa996eaf52f24a45ae57",
    276
  ],
  [
    "v3.1.4",
    "18379a4cd99ac78d62e4d2bd4ff3276cd06725e4",
    "sha256:f86272cda1ef4ce4ce746f604b15fd0c4a14c4358ab10b5f0e4b5f1415dcb235",
    1198165,
    "69ddc0aaad52650f5f6b54d2c91f48d25a819980f4f3a657da573cc388c2a006",
    "18379a4cd99ac78d62e4d2bd4ff3276cd06725e4",
    277
  ],
  [
    "v3.2.0",
    "c39063b4756a9ec7854069e9f04b4b86ad490803",
    "sha256:07d63b625c0b016125f8e07b03759ce7556a2b59adc0fd5f324eed5f8cf1156c",
    1308149,
    "1def32976d947bdfe38c8eb4d2507d341f2fbdac7c1d07a6d7776b889e8c217d",
    "c39063b4756a9ec7854069e9f04b4b86ad490803",
    290
  ],
  [
    "v3.2.1",
    "46d96b6d49738e28b11ea2d4c56fac9ba21701a7",
    "sha256:0d262e60b8a9cfba657783434924ca850dba4dd87a9dd620c590ba8e228abf73",
    1309052,
    "a5cf0029868045b960e750fc68ce4a94dcf6872fb4576eec983a63b093e49b73",
    "9f33e759acd763497135043504dc048dcc599c31",
    292
  ],
  [
    "v3.2.2",
    "7b541095b057a68e0090d8348bdc96a70dc56be8",
    "sha256:cf994066362288d92a64cac240e173136346ac510414681488662b72fc345a1e",
    1321851,
    "7b6ecae0ff18726df6174f36addaf9c6bda3df07e8ace7e219a922d108b832f4",
    "7b541095b057a68e0090d8348bdc96a70dc56be8",
    297
  ],
  [
    "v3.2.3",
    "6309d35929e484ebff70c7da68547fb9c60f0d11",
    "sha256:c1c8fa6d0c640bd96bb5833ab372ceb37aa8e578c1a402f6e8d2585912539b12",
    1326282,
    "39df0b6f2f860bafc05fbdf659af1276aec28891ec69753216c2b895e7d398ea",
    "6309d35929e484ebff70c7da68547fb9c60f0d11",
    298
  ],
  [
    "v3.2.4",
    "312c0be95983a98bed4120526351a94219d00449",
    "sha256:252fd3342909c8152b530a249579439e6c293df7071a662a2c6bf5f76b118b2a",
    1488779,
    "5d210416a8ae972db6b4a353bbb91afc84dc292f3210805771657c804be23f16",
    "312c0be95983a98bed4120526351a94219d00449",
    301
  ],
  [
    "v3.2.5",
    "67c7ac6923b498c15f5541fd0e9ddcbeed38c3b7",
    "sha256:bf47233a00fb922ba63eeb2c2f36a2e5064d747b7dc7d4f098d5d45cd3e21aed",
    1493673,
    "6bd00d365aa90bb01b7374274f0b8bc92f240545464d0820b4eccd95c8207577",
    "67c7ac6923b498c15f5541fd0e9ddcbeed38c3b7",
    302
  ],
  [
    "v3.2.6",
    "737e4acb173cddbe6fde9c6085853ef8b8f02a80",
    "sha256:8af1973b94bcbed8976df4ab5dbd8ab9e54c35e893647bbb5f1b0be35251333d",
    1500264,
    "fc190f8805f2a1675eba6fa19123de5dd3510ce1d31830785622e09585f329c0",
    "737e4acb173cddbe6fde9c6085853ef8b8f02a80",
    306
  ],
  [
    "v3.2.7",
    "81ee047fd124f8837555fd79e8a3957688c5b0c6",
    "sha256:6eb6f212e5838377287e32cb1e0644698a4b8eef1eaa0f9c75edd9cf52a5c335",
    1502404,
    "f7fca12e8f18d9f3f4d7bc5be33e1389f9c4ec4f4116aae6859f0024b05585c9",
    "81ee047fd124f8837555fd79e8a3957688c5b0c6",
    315
  ],
  [
    "v3.2.8-320",
    "835a2c90294705b5963043f5ef31460304df2475",
    "sha256:05836f3355ce09ecba279944216e8b6119b120e94e8d180004993ab4aaebc203",
    1567532,
    "b4c59a07daf0ba5b53d110c92c2d08d6858533769aa40c0c78e6906902b8832a",
    "835a2c90294705b5963043f5ef31460304df2475",
    320
  ],
  [
    "v3.2.9-323",
    "79010a36cdb8391bb5de5c86acd0387d71f462c9",
    "sha256:81084f7a0046b58c2645fbcf8971eb33bf4041c3d77badaaba6f8efa3d67be1f",
    1569269,
    "c32e6488cfce93f87ecbd426ed8eb7001ae90613cc75c5a1a93f3b0f2ef8a5c5",
    "79010a36cdb8391bb5de5c86acd0387d71f462c9",
    323
  ],
  [
    "v3.2.9-326",
    "ae2b37364ce53cf9af44d4088f4ef53ad859f8b8",
    "sha256:8d5a5e7a6036e60896fd4540ee6c6d6fd45a704e431abae571ef54ee93e9b43b",
    1659177,
    "14c8a2546c72aff24ee9c5f2ded73e39ca7e0bf82c268c63d337141268d816c9",
    "ae2b37364ce53cf9af44d4088f4ef53ad859f8b8",
    326
  ],
  [
    "v3.2.10-334",
    "6218ecc5cdab527a649c8fa5b0194db3f884571c",
    "sha256:bf395821692d572e9396e27955a881e36ac24c0f3275c6ad1a0d75beea121aa4",
    2186299,
    "f55a84fd5592d0662d1b0bd40dc73065ab92177b40703f76502f8aab216ad073",
    "6218ecc5cdab527a649c8fa5b0194db3f884571c",
    334
  ],
  [
    "v3.2.11-338",
    "1f520ed9587ce588994d48937aca0de8262cf784",
    "sha256:a8dc28f00d371bee3230a9b336496bbb46e4b9f3232c034f7ae4c93c5b7419cf",
    2186687,
    "e20c6d28f7732e6202d5c2a58d7f6443266797d8f6dbf2cee9aa34dc7d795add",
    "1f520ed9587ce588994d48937aca0de8262cf784",
    338
  ],
  [
    "v3.2.12-342",
    "6a76ecc0d576c13f32189393360f2d95fb4a78f2",
    "sha256:b3ab9c0ce672b7287a0573080a6d78dad6e27a47ccced6afcb662c0ca93645db",
    2182116,
    "edcc2710aaa7ca6811f47ea24966195fd41901f22df4652397b28d18aa70f2f8",
    "6a76ecc0d576c13f32189393360f2d95fb4a78f2",
    342
  ],
  [
    "v3.2.13-343",
    "b179867c306fb6a28345896f422910e603799d70",
    "sha256:b84fa52c29d534d63711ac3d2a465993e1fce91d446ffcf740989f09945416db",
    2184713,
    "bc33acc0fd8734b1469e1cfccee255d205e4fffecde8d5f86dae390090a6f150",
    "b179867c306fb6a28345896f422910e603799d70",
    343
  ],
  [
    "3.2.14-345",
    "8f33f8cbf6b958b9ec215424a50d96cd2fc5e5ae",
    "sha256:b0b4092b7b79b72453b9439435d23d80f910c56a921a0ef081b2c2d3375fa5ba",
    2184188,
    "c93d5245e9acc8665d6ec03d1c1d9692aff9fcf46a3244c5f89cc5c2f9d874b0",
    "8f33f8cbf6b958b9ec215424a50d96cd2fc5e5ae",
    345
  ],
  [
    "v3.2.15-347",
    "11c63308db6ff05afc86ebab2773c1dc02e1afbf",
    "sha256:f0e47a0a3820ed30d82ceaede132cdf790ef7e326fec822cdf0253d33cd3f809",
    2184694,
    "d469d50778f964bee78d03e7819138d88b84e85871c04428944925b1a241dbcd",
    "6304dbedc34c6b271546a9338d9b870ceb1ac625",
    347
  ],
  [
    "v3.2.15-348",
    "459fa72d1468b6dc7485de7392996de50169fbf8",
    "sha256:88c9d5d77b282d5e0ed549cca796f2a1f1fa7cf01e1798f84492be28b30ed92a",
    2184775,
    "5700e21f72fa0331dc072c9ffea40590fa79cbae47df9d6ad4cc9a240fa71491",
    "459fa72d1468b6dc7485de7392996de50169fbf8",
    348
  ],
  [
    "v3.2.16-349",
    "20cbabc70fb2528d166ab2a296a1d656a6e5a106",
    "sha256:9bab82cbc2e613757b1b5103f62ea137542c52b987cf95645c58250d0a3eca82",
    2183691,
    "dfb0eaee1ab50b67241c1ce559d8a58525367503da5a222f62bd0eb10a3c97ad",
    "20cbabc70fb2528d166ab2a296a1d656a6e5a106",
    349
  ],
  [
    "v3.2.17-350",
    "4d3a7ab3422f587c3f3faa855dd03d73ccbcbfdf",
    "sha256:146ec7ea4d87b65967ebedee1414ff88a2c39f249cc887cfa987ef73096859a0",
    2183772,
    "e10f8f8d817b4ca9467b7476bfd0a20b7969383892bdfc4fce2bf87c5f2b3570",
    "4d3a7ab3422f587c3f3faa855dd03d73ccbcbfdf",
    350
  ],
  [
    "v3.2.19-352",
    "024a3049157b83329e041f3e60ae3da611a022bb",
    "sha256:c2e6f13e223925fc7e6da64b64beeef4d569b58b90fbca5d79c94d94a4371e10",
    2183530,
    "d4e8bf5db3f21b2bf73f1e636989547c00cda7e99ef9111782e16dd804f9db4e",
    "024a3049157b83329e041f3e60ae3da611a022bb",
    352
  ],
  [
    "v3.3.0-361",
    "52378dc3e911cdfc7b8e3cf1160a6e0e4dde4fd6",
    "sha256:c5c2b17c37ee2866fb8f1552eb5f24c47ece7f4dc372ddfa4e87b9772f8cb6cd",
    2180265,
    "4a424aa586f4ff246066ff807ae3739ec58081b1847f09342022ac5864b4cfe8",
    "52378dc3e911cdfc7b8e3cf1160a6e0e4dde4fd6",
    361
  ],
  [
    "v3.3.1-362",
    "8834a7c737583c8ab8d6c3abdbd4865e039e24a9",
    "sha256:039e4d79a4e9577126b71ff8630eab06d077bc591bbe495fe1d8c5d056dd59a8",
    2180002,
    "d473684c754eae2bf72ff0461bd0bd80105f5f64a37e83f6ff34c0036e2c3211",
    "8834a7c737583c8ab8d6c3abdbd4865e039e24a9",
    362
  ],
  [
    "v3.3.2-365",
    "6e3d24cea446b3241524bb319b72bf506e8e8eb4",
    "sha256:83c3e767e65c292336effccea610a8f4838627b183d31ad49a6f83ea113100e4",
    2137480,
    "b253c51b77938c2a4013751427fcb59f8d83fd797f55a6dbaa6103ee1839daba",
    "6e3d24cea446b3241524bb319b72bf506e8e8eb4",
    365
  ],
  [
    "v3.3.4-367",
    "8f13194c6e56f218910b4a9c708199cc38f64c40",
    "sha256:323aac618e07c26c4a5189ab0eb4c3c942fdfcae16edf86d929d30a5138a7c81",
    2136394,
    "cd9b68b696518f5b916177bb39f65704b1eebcc625f629814dc4264bb82bb05c",
    "8f13194c6e56f218910b4a9c708199cc38f64c40",
    367
  ],
  [
    "v3.3.5-372",
    "f74d69ed52e66c42476c94cdbeac8018f5c5567b",
    "sha256:2258126d5ebbc8da39eac2fa6a64a129f01072ade8a18462bd7ca7abc223bcbd",
    2143047,
    "977b16b53db8da97ae7749889445dcdde0a6a0635495f22824442c9a68ce9ea3",
    "f74d69ed52e66c42476c94cdbeac8018f5c5567b",
    371
  ],
  [
    "v3.3.7-373",
    "206e7c890d2ac4268257cfd205bcf80100225241",
    "sha256:f40a2a9670517f2360ffa1d2d8d0168900f37f6cf3c65c1faf3f4052dfd4bb5a",
    2139919,
    "94c71b20adf391c12f3d590dd45f9ad7e96bdfaca2d043241df94830372fd489",
    "206e7c890d2ac4268257cfd205bcf80100225241",
    373
  ],
  [
    "v3.3.8-374",
    "54504b674929bbce60845aa16110baff3105f90c",
    "sha256:6827f82eac90b2b8e4ebb144b472b3fc8c968a9cc7ec1bf8615c01b65f4a27a7",
    2141258,
    "4549d458ddbdfdbeb3cbc36756f684e04e26d08d5325b0a5ed17a5d7e74de611",
    "54504b674929bbce60845aa16110baff3105f90c",
    374
  ],
  [
    "v3.3.12-391",
    "7a727dd4d219a953391e91ed2f7aa942050938f1",
    "sha256:4d7635b8eb30a525564703ea55f46650401b5444854381fc6f60781b9081401f",
    2167247,
    "cc251ff778aa6a570f57b8ec0804ee7aad24e0a17f4e276da4de4f1a64d0f7c2",
    "7a727dd4d219a953391e91ed2f7aa942050938f1",
    391
  ],
  [
    "v3.3.14-401",
    "40a451f366900d00ec0b3781e4c5a4a92ba9a6b6",
    "sha256:97117a2c79e6e5363d0615e42dc38e97cfd2d26dcf55c9f9f1d7ca024eeedb37",
    2207774,
    "88d599d5dd6f677428cbd394931e8d23f173a01e35ffa9bff60d98198ee1f424",
    "40a451f366900d00ec0b3781e4c5a4a92ba9a6b6",
    401
  ],
  [
    "v3.4.0-411",
    "486037ba45b87a453b1d660177cc1b105d0298c6",
    "sha256:9c1598568d5e0f0b1e6529bdf4ce1aa9611339b71c30897a8e7ebeed4e1e5a0f",
    2240623,
    "973871df0259e40643ca15d1aa7864b2ce53768628168d0d61919726cdb34502",
    "486037ba45b87a453b1d660177cc1b105d0298c6",
    411
  ],
  [
    "v3.4.1-413",
    "e3aed6244085b84d787f2fb2afb346bd993dc812",
    "sha256:669c1a4a4788cabb2a859f1006604294f3e2bda3a591680168b21b7861b8031b",
    2249723,
    "872294c083277a0cab672fa283c3c82bb19f337b728fbb4854c09557429a15fc",
    "ec2212c53fc7c0252af80c28e50a959cce2f9890",
    413
  ],
  [
    "v3.4.2-415",
    "1104f2aab5acdf69fe967a787c7ae1cc5fdf170c",
    "sha256:fc3be3f5e428167f8e77c484695925208576765b060e64fbb876edb9471182b7",
    2256783,
    "f30f2755716d6c13099cb2999f40fd33c929ebc1903b75c2c758baae8ceeae07",
    "1104f2aab5acdf69fe967a787c7ae1cc5fdf170c",
    415
  ],
  [
    "v3.4.3-416",
    "3c5aff01d9508a31a01fca2231ee7c6d0b14905a",
    "sha256:39dc60f96a0a44242f7cc16273c4b1d7f735e7faf214bd62cc350eb7a949585d",
    2262044,
    "818e603031f42d6291cae0368d5aab6f7fe545bfa178ec7f1c796dfc5268feb1",
    "3c5aff01d9508a31a01fca2231ee7c6d0b14905a",
    416
  ],
  [
    "v3.4.4-417",
    "49164bd68afd71e48e3c80d268ed80f22b98a2b1",
    "sha256:f667b6e353e32ff7da4450aa23a55e7969199a966f7408f47e82d7804e7c3793",
    2263054,
    "10eedece00b86b275562b9288174d52cc637bce0ea8883471119d3b30286e4ae",
    "49164bd68afd71e48e3c80d268ed80f22b98a2b1",
    417
  ],
  [
    "v3.4.5-419",
    "fa83646297f45a1a8108f70ba2ebf32d4f35b5c2",
    "sha256:e6506f6a361946b2d74a524c9e80b9357df4f921b31ba3f91313e0f521ed1695",
    2264622,
    "390c6419a593396224865491f07eb905e7c7940c3a505bf222923c16b17df593",
    "fa83646297f45a1a8108f70ba2ebf32d4f35b5c2",
    419
  ],
  [
    "v3.4.6-421",
    "6016381e4fb230d17643cca948afe296eb06faac",
    "sha256:6f42162ca270e56f008b3b90933bda176a953517d43ca023883575c45bb0bffe",
    2263977,
    "7a885e66bb8c839359ce8cd1e9d938db961594433898a503855cebb5017e5b15",
    "6016381e4fb230d17643cca948afe296eb06faac",
    421
  ],
  [
    "v3.4.7-422",
    "e367ae64709a22cfeb7ec114814a14f0db137a83",
    "sha256:037cb0e809b088e1753ddcf98df3637e2c32cd1cab0f624650e262a4ae663023",
    2264489,
    "2b25273bbf2d08c17f325da99159e5e0d3d2632ca7b0976656425f52decce2c8",
    "e367ae64709a22cfeb7ec114814a14f0db137a83",
    422
  ],
  [
    "v3.4.8-423",
    "06032d518fbaead1ddc2039e9e6aa55715026364",
    "sha256:b05172092a7cbb0a79cccd6fc5fee11fa015c922525fefa9fc256452268e8dc8",
    2282880,
    "190def0d297eb5a4f932c114b7ddecc6afbfcd5a91578e029b517701326c382b",
    "06032d518fbaead1ddc2039e9e6aa55715026364",
    423
  ],
  [
    "v3.4.9-424",
    "6d81084c5c13413d9e3637586280125c0bfc1948",
    "sha256:df6b74e5812f8bc406e16476245a6382476984f9ded1bf68f5ee72db376a47c8",
    2283469,
    "52d28cbe8dfd449e0f1dd2171672740e3c8af65558127ce2ddc3b4e2941820bd",
    "6d81084c5c13413d9e3637586280125c0bfc1948",
    424
  ]
] as const;

function download(url: string, maxBuffer: number) {
  return execFileSync("curl", ["--fail", "--location", "--max-time", "30", "--silent", "--show-error", url], { maxBuffer });
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function extract(tag: string, commit: string, publishedHash: string, publishedBytes: number, digestHash: string, tagCommit: string, expectedSpec: number) {
  const base = `https://github.com/RaoFoundation/subtensor/releases/download/${tag}`;
  const manifestBytes = download(`${base}/subtensor-digest.json`, 32768);
  assert.equal(digest(manifestBytes), digestHash);
  const manifest = JSON.parse(manifestBytes.toString());
  assert.equal(manifest.commit, commit);
  assert.equal(manifest.info.git.commit, commit);
  assert.equal(manifest.runtimes.compressed.sha256, manifest.sha256);
  assert.equal(Number(manifest.runtimes.compressed.size), publishedBytes);
  const spec = manifest.runtimes.compressed.subwasm.core_version.specVersion;
  assert.equal(spec, expectedSpec);
  const blob = download(`${base}/subtensor.wasm`, 8 * 1024 * 1024);
  assert.equal(blob.length, publishedBytes);
  assert.equal(`0x${digest(blob)}`, manifest.wasm_sha256 ?? manifest.sha256);
  if (publishedHash) assert.equal(`sha256:${digest(blob)}`, publishedHash);
  assert.ok(blob.subarray(0, 8).equals(Buffer.from([82, 188, 83, 118, 70, 219, 142, 5])));
  const wasm = decompress(blob.subarray(8));
  assert.ok(wasm.length < 50 * 1024 * 1024);
  const module = await WebAssembly.compile(wasm);
  const initialMemory = new WebAssembly.Memory({ initial: 64, maximum: 2048 });
  let memory = initialMemory;
  let heap = 0;
  const malloc = (bytes: number) => {
    if (heap === 0) {
      const base = instance.exports.__heap_base;
      assert.ok(base instanceof WebAssembly.Global);
      heap = Number(base.value);
    }
    // Substrate RuntimeAllocator requires the host's eight-byte header.
    const ptr = Math.ceil(heap / 8) * 8 + 8;
    heap = ptr + Math.max(bytes, 8);
    if (heap > memory.buffer.byteLength) memory.grow(Math.ceil((heap - memory.buffer.byteLength) / 65536));
    return ptr;
  };
  const hostCalls: Record<string, number> = {};
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
  for (const item of WebAssembly.Module.imports(module)) {
    const group = imports[item.module] ??= {};
    if (item.kind === "memory") group[item.name] = initialMemory;
    else if (item.kind === "function") group[item.name] = (...args: (number | bigint)[]) => {
      hostCalls[item.name] = (hostCalls[item.name] ?? 0) + 1;
      if (item.name === "ext_allocator_malloc_version_1") return malloc(Number(args[0]));
      if (item.name === "ext_allocator_free_version_1") return;
      if (item.name === "ext_logging_max_level_version_1") return 0;
      throw new Error(`Unexpected compiled metadata host call v${spec}: ${item.name}`);
    };
    else throw new Error(`Unsupported metadata import: ${item.kind} ${item.name}`);
  }
  const instance = await WebAssembly.instantiate(module, imports);
  if (instance.exports.memory instanceof WebAssembly.Memory) memory = instance.exports.memory;
  const ptr = malloc(4);
  const invoke = (name: string, bytes: number) => {
    const call = instance.exports[name];
    assert.equal(typeof call, "function");
    const packed = BigInt((call as CallableFunction)(ptr, bytes));
    return Buffer.from(new Uint8Array(memory.buffer, Number(packed & 0xffffffffn), Number(packed >> 32n)));
  };
  const runtimeVersion = new TypeRegistry().createType("RuntimeVersion", invoke("Core_version", 0)).toJSON();
  assert.deepEqual(runtimeVersion, manifest.runtimes.compressed.subwasm.core_version);
  const metadata: Record<string, string> = {};
  for (const version of [14, 15]) {
    new DataView(memory.buffer).setUint32(ptr, version, true);
    const bytes = invoke("Metadata_metadata_at_version", 4);
    assert.notEqual(bytes.toString("hex"), "00", `${tag} does not export metadata V${version}`);
    assert.ok(bytes.length > 0 && bytes.length <= 2 * 1024 * 1024);
    const wrapped = `0x${bytes.toString("hex")}`;
    const model = decodeNativeMetadata(unwrapNativeMetadata(wrapped)!);
    assert.equal(model.version, version);
    metadata[`v${version}`] = wrapped;
    metadata[`v${version}_sha256`] = digest(bytes);
    console.log("NATIVE_RELEASE_METADATA", JSON.stringify({ tag, spec, version, commit, wasm_sha256: digest(blob), metadata_bytes: bytes.length, metadata_sha256: digest(bytes), types: model.types.size, pallets: model.pallets.length, apis: model.apis.length, fixture: true, production: false }));
  }
  console.log("NATIVE_RELEASE_METADATA_HOSTS", JSON.stringify({ spec, hostCalls }));
  return { tag, tag_commit: tagCommit, spec, commit, wasm_sha256: digest(blob), digest_sha256: digest(manifestBytes), runtimeVersion, ...metadata };
}

test("extract compiled pre-v430 release contracts on remote CI only", async () => {
  if (!process.env.CI) return;
  const fixtures = [];
  for (const [tag, commit, sha256, bytes, digestHash, tagCommit, spec] of releases) fixtures.push(await extract(tag, commit, sha256, bytes, digestHash, tagCommit, spec));
  const compressed = brotliCompressSync(Buffer.from(JSON.stringify(fixtures)), { params: { [constants.BROTLI_PARAM_QUALITY]: 6, [constants.BROTLI_PARAM_LGWIN]: 24 } }).toString("base64");
  const source = `// Checksum-verified official Subtensor release WASM metadata, v1.1.7–v3.4.9-424.\n// Extracted on remote CI; no deployed state, contract execution or submission.\n// Source: https://github.com/RaoFoundation/subtensor/releases\nimport { brotliDecompressSync } from "node:zlib";\nexport interface CompiledLegacyRuntimeEra {\n  tag: string;\n  tag_commit: string;\n  digest_sha256: string;\n  spec: number;\n  commit: string;\n  wasm_sha256: string;\n  runtimeVersion: { specName: string; specVersion: number; transactionVersion: number; apis: [string, number][] };\n  v14: string;\n  v14_sha256: string;\n  v15: string;\n  v15_sha256: string;\n}\nconst compressed = [\n${compressed.match(/.{1,120}/g)!.map((part) => JSON.stringify(part)).join(",\n")}\n].join("");\nexport default JSON.parse(brotliDecompressSync(Buffer.from(compressed, "base64")).toString()) as CompiledLegacyRuntimeEra[];\n`;
  const name = "tests/fixtures/native-runtime-legacy-compiled.ts";
  const head = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
  const files = [
    { path: name, source, previous_sha256: null },
    ...["tests/native-runtime-legacy.test.ts", "tests/native-runtime-eras.test.ts"].map((path) => {
      const text = readFileSync(path, "utf8");
      return { path, source: text, previous_sha256: digest(Buffer.from(text)) };
    }),
  ];
  for (let file_index = 0; file_index < files.length; file_index++) {
    const file = files[file_index]!;
    const formatted = await format(file.source, { ...(await resolveConfig(file.path)), filepath: file.path });
    const encoded = gzipSync(formatted).toString("base64");
    console.log("NATIVE_LEGACY_HANDOFF", JSON.stringify({ file_index, path: file.path, head, previous_sha256: file.previous_sha256, encoding: "gzip-base64", bytes: Buffer.byteLength(formatted), sha256: digest(Buffer.from(formatted)), chunks: Math.ceil(encoded.length / 16000), releases: fixtures.length }));
    for (let offset = 0; offset < encoded.length; offset += 16000) console.log("NATIVE_LEGACY_FILE_CHUNK", JSON.stringify({ file_index, index: offset / 16000, data: encoded.slice(offset, offset + 16000) }));
  }
}, 1200000);
