"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createKadiV1ProductionFlowReplyComposition}=require("../kadiV1ProductionFlowReplyComposition");
test("production Flow composition has zero boot I/O",()=>{
 let calls=0;
 const value=createKadiV1ProductionFlowReplyComposition({
  supabase:{from(){calls++;throw new Error("BOOT_QUERY")},rpc(){calls++;throw new Error("BOOT_RPC")}},
  commandRuntime:{async execute(){calls++;throw new Error("BOOT_COMMAND")}}
 });
 assert.equal(calls,0);
 assert.equal(value.readiness.ready,true);
 assert.equal(typeof value.flowReplyRuntime.handle,"function");
});
test("production Flow composition validates dependencies",()=>{
 assert.throws(()=>createKadiV1ProductionFlowReplyComposition({supabase:{from(){},rpc(){}}}),/KADI_V1_PRODUCTION_FLOW_COMMAND_RUNTIME_REQUIRED/);
 assert.throws(()=>createKadiV1ProductionFlowReplyComposition({supabase:{},commandRuntime:{execute(){}}}),/KADI_V1_SUPABASE_SESSION_CLIENT_REQUIRED/);
});
