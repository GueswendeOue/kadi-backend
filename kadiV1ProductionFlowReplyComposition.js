"use strict";
const {createConversationSessionService}=require("./kadiV1ConversationSession");
const {createKadiV1FlowReplyRuntime}=require("./kadiV1FlowReplyRuntime");
const {createSupabaseV1ConversationSessionRepository}=require("./kadiV1SupabaseConversationSessionRepository");
function createKadiV1ProductionFlowReplyComposition({supabase,commandRuntime,ttlMs,clock,idFactory}={}){
 if(!commandRuntime||typeof commandRuntime.execute!=="function") throw new TypeError("KADI_V1_PRODUCTION_FLOW_COMMAND_RUNTIME_REQUIRED");
 const sessionRepository=createSupabaseV1ConversationSessionRepository(supabase);
 const options={repository:sessionRepository};
 if(ttlMs!==undefined) options.ttlMs=ttlMs;
 if(clock!==undefined) options.clock=clock;
 if(idFactory!==undefined) options.idFactory=idFactory;
 const sessionService=createConversationSessionService(options);
 const flowReplyRuntime=createKadiV1FlowReplyRuntime({sessionService,commandRuntime});
 return Object.freeze({sessionRepository,sessionService,flowReplyRuntime,readiness:Object.freeze({ready:true,persistent_session_repository:true,session_service:true,flow_reply_runtime:true,boot_external_calls:0})});
}
module.exports={createKadiV1ProductionFlowReplyComposition};
