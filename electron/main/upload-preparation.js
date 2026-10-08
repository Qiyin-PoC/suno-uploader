function createUploadPreparation(timeoutMs=45000) {
  const controller=new AbortController();
  const deadline=performance.now()+timeoutMs;
  const fail=(code,message)=>Object.assign(new Error(message),{code});
  const timer=setTimeout(()=>controller.abort(fail('suno_network_error','上传准备超时，登录资料已保留，请检查网络或连接助手后重试。')),timeoutMs);
  timer.unref?.();
  const check=()=>{if(controller.signal.aborted)throw controller.signal.reason;};
  return {
    signal:controller.signal,
    check,
    remainingMs:()=>Math.max(1,Math.ceil(deadline-performance.now())),
    cancel:()=>controller.abort(fail('upload_cancelled','已停止上传准备。')),
    dispose:()=>clearTimeout(timer),
    wait(promise,onLateValue) {
      return new Promise((resolve,reject)=>{
        let settled=false;
        const abort=()=>{if(!settled){settled=true;reject(controller.signal.reason);}};
        controller.signal.addEventListener('abort',abort,{once:true});
        if(controller.signal.aborted)abort();
        Promise.resolve(promise).then(value=>{
          controller.signal.removeEventListener('abort',abort);
          if(settled){try{Promise.resolve(onLateValue?.(value)).catch(()=>{});}catch{};return;}
          settled=true;resolve(value);
        },error=>{
          controller.signal.removeEventListener('abort',abort);
          if(!settled){settled=true;reject(error);}
        });
      });
    },
  };
}
module.exports={createUploadPreparation};
