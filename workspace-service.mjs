export function createWorkspaceService({readSettings,writeSettings,enqueue,api}){
  return change=>enqueue(async()=>{const current=await readSettings();const patch=api.mutate(current,change);const settings=await writeSettings(patch);return{ok:true,settings}});
}
