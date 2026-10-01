import { test, expect } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";

const hash=`0x${"33".repeat(32)}`;
const source={network:"finney",network_genesis_hash:`0x${"44".repeat(32)}`,finalized_block_hash:hash,finalized_block:"500",runtime_spec_version:470,runtime_transaction_version:1,metadata_version:15,metadata_sha256:`0x${"55".repeat(32)}`};
test.use({serviceWorkers:"block"});
test("native feature reads are explicit, exact and usable at phone width",async({page})=>{
  await page.setViewportSize({width:375,height:812});
  const requests:unknown[]=[];
  await page.route("**/api/v1/native-runtime",async(route)=>{
    requests.push(route.request().postDataJSON());
    await route.fulfill({json:{ok:true,data:{schema_version:1,source,types:[],results:[{kind:"storage",pallet:"SubtensorModule",member:"MechanismCountCurrent",value:"2",contract:{root_type:0}},{kind:"storage",pallet:"SubtensorModule",member:"MechanismEmissionSplit",value:["9007199254740993","65535"],contract:{root_type:1}}]}}});
  });
  await gotoThroughRestart(page,"/apis/native");
  await expect(page.getByRole("heading",{name:"Native chain",exact:true})).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.getByRole("button",{name:"Read state",exact:true}).click();
  await expect(page.getByRole("cell",{name:"9007199254740993",exact:true})).toBeVisible();
  await expect(page.getByText("v470 · metadata v15",{exact:true})).toBeVisible();
  expect(requests).toEqual([{operations:[{kind:"storage",pallet:"SubtensorModule",member:"MechanismCountCurrent",args:[19]},{kind:"storage",pallet:"SubtensorModule",member:"MechanismEmissionSplit",args:[19]}]}]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test("metadata-discovered calls use their declared arguments and pinned contract source",async({page})=>{
  const requests:{operations:{kind:string}[];as_of?:string}[]=[];
  await page.route("**/api/v1/native-runtime",async(route)=>{
    const body=route.request().postDataJSON();requests.push(body);
    const discovery=body.operations[0].kind==="describe";
    await route.fulfill({json:{ok:true,data:{schema_version:1,source,types:[{id:0,path:["TaoBalance"],definition:{kind:"primitive",primitive:6}}],results:discovery?[{kind:"describe",value:[{kind:"prepare",pallet:"SubtensorModule",member:"stake",args:[{name:"amount",type:0}]}],contract:{total:1,next_offset:null}}]:[{kind:"prepare",pallet:"SubtensorModule",member:"stake",call_data:"0x0754010203",contract:{}}]}}});
  });
  await gotoThroughRestart(page,"/apis/native");
  await page.getByRole("button",{name:"Inspect contract"}).click();
  await expect(page.getByText("TaoBalance",{exact:true})).toBeVisible();
  await page.getByLabel("Arguments (JSON array)").fill('[9007199254740993]');
  await page.getByRole("button",{name:"Prepare unsigned call"}).click();
  await expect(page.getByRole("alert")).toContainText("decimal strings");
  expect(requests).toHaveLength(1);
  await page.getByLabel("Arguments (JSON array)").fill('["9007199254740993"]');
  await page.getByRole("button",{name:"Prepare unsigned call"}).click();
  await expect(page.getByRole("cell",{name:"0x0754010203",exact:true})).toBeVisible();
  expect(requests[1]).toEqual({as_of:hash,operations:[{kind:"prepare",pallet:"SubtensorModule",member:"stake",args:["9007199254740993"]}]});
});
test("failed native reads do not leave a prior response presented as the new state",async({page})=>{
  let count=0;
  await page.route("**/api/v1/native-runtime",(route)=>route.fulfill(++count===1?{json:{ok:true,data:{schema_version:1,source,types:[],results:[{kind:"storage",pallet:"P",member:"C",value:"123456",contract:{}}]}}}:{status:502,json:{ok:false,error:{message:"The finalized read failed."}}}));
  await gotoThroughRestart(page,"/apis/native");
  await page.getByRole("button",{name:"Read state",exact:true}).click();
  await expect(page.getByRole("cell",{name:"123456",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Read state",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("The finalized read failed.");
  await expect(page.getByRole("cell",{name:"123456",exact:true})).toHaveCount(0);
});
