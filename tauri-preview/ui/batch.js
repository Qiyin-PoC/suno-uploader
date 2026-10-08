/* Shared by the desktop UI and queue regression tests. */
(function(root){
  function downloadUrls(text){
    const lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    if(!lines.length)throw new Error('请先粘贴歌曲链接，每行一个。');
    const urls=[...new Set(lines)];
    if(urls.length>100)throw new Error('每批最多 100 首歌曲。');
    for(const value of urls){
      let u;try{u=new URL(value);}catch{throw new Error('无效歌曲链接：'+value);}
      if(u.protocol!=='https:'||!['suno.com','www.suno.com'].includes(u.hostname)||u.username||u.password||!/^\/song\/[a-zA-Z0-9-]+\/?$/.test(u.pathname))throw new Error('请使用 Suno 歌曲链接：'+value);
    }
    return urls;
  }
  async function processQueue(items,execute,stopped,changed){
    for(const item of items){
      if(stopped())break;
      if(item.status!=='pending')continue;
      item.status='running';item.message='正在启动…';item.progress=null;changed();
      let result;
      try{result=await execute(item);}catch(e){result={status:'failed',message:String(e),fatal:true};}
      item.status=result.status;item.message=result.message||item.message;
      if(item.status==='succeeded')item.progress=100;
      changed();
      if(result.fatal||result.status==='cancelled')break;
    }
  }
  const api={downloadUrls,processQueue};
  if(typeof module!=='undefined')module.exports=api;else root.QiyinBatch=api;
})(globalThis);
