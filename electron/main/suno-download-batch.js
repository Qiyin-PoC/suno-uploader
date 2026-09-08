const crypto = require('node:crypto');

// Keep one worker at a time; every song retains the standalone integrity checks.
class SunoDownloadBatch {
  constructor(options, Worker, normalizeUrl) {
    this.onState = options.onState;
    this.normalizeUrl = normalizeUrl;
    this.active = null;
    this.closed = false;
    this.worker = new Worker({...options, onState: state => this.accept(state)});
    this.state = {...this.worker.snapshot(), items: []};
  }
  get outputDirectory() { return this.worker.outputDirectory; }
  reject(message, errorCode) { return {ok:false, message, errorCode}; }
  snapshot() { return {...this.state, items:this.state.items.map(item=>({...item}))}; }
  publish(update) {
    this.state = {...this.state, ...update, outputDirectory:this.outputDirectory};
    this.onState?.(this.snapshot());
    return this.snapshot();
  }
  accept(state) {
    const batch = this.active;
    if (!batch) return;
    const item = this.state.items[batch.index];
    if (item) Object.assign(item, {status:state.status, filename:state.filename || '', message:state.message || ''});
    this.publish({...state, taskId:batch.id, running:true, status:'running',
      message:`第 ${batch.index+1} / ${this.state.items.length} 首：${state.message || ''}`});
  }
  async start(payload = {}) {
    if (this.active || this.closed) return this.reject('已有下载正在处理，请稍候。','BUSY');
    const raw = Array.isArray(payload?.urls) ? payload.urls : String(payload?.url || '').split(/\r?\n/).filter(line=>line.trim());
    if (!raw.length || raw.length>100) return this.reject('请每行填写一个链接，一次最多 100 首。','INVALID_URL');
    const urls = raw.map(this.normalizeUrl);
    const invalid = urls.findIndex(url=>!url);
    if (invalid>=0) return this.reject(`第 ${invalid+1} 行不是有效的 Suno 歌曲链接，请修改后重试。`,'INVALID_URL');
    if (!['mp3','wav'].includes(payload.format)) return this.reject('请选择 MP3 或 WAV。','INVALID_FORMAT');
    const unique = [...new Map(urls.map(url=>[new URL(url).pathname.replace(/\/$/,''),url])).values()];
    const batch = {id:crypto.randomUUID(), index:0, cancelled:false};
    this.active = batch;
    this.publish({ok:true, taskId:batch.id, status:'running', running:true, phase:'authorizing',
      format:payload.format, filename:'', progress:null, message:'正在准备下载队列…',
      items:unique.map(url=>({url,status:'pending',filename:'',message:'等待下载'}))});
    batch.done = this.run(batch, unique, payload.format);
    return this.snapshot();
  }
  async run(batch, urls, format) {
    try {
      for (let index=0; index<urls.length && !batch.cancelled; index++) {
        batch.index=index;
        const result = await this.worker.start({url:urls[index],format});
        if (this.worker.active) await this.worker.active.done;
        else if (!result.taskId) Object.assign(this.state.items[index], {status:'failed',message:result.message});
        // An entitlement error affects the entire batch, not just this song.
        if (this.worker.snapshot().needActivate) break;
      }
    } catch {
      Object.assign(this.state.items[batch.index], {status:'failed',message:'下载组件发生异常，请重试。'});
    } finally {
      for (const item of this.state.items) if (item.status==='pending') {
        item.status='cancelled'; item.message=batch.cancelled?'已取消':'未开始，请检查软件权益后重试';
      }
      const saved=this.state.items.filter(item=>item.status==='succeeded');
      const failed=this.state.items.filter(item=>item.status==='failed').length;
      const cancelled=this.state.items.filter(item=>item.status==='cancelled').length;
      this.active=null;
      const status=batch.cancelled?'cancelled':failed||cancelled?'failed':'succeeded';
      this.publish({ok:status==='succeeded', running:false, status, phase:status, indeterminate:false,
        progress:100, filename:saved.at(-1)?.filename || '',
        message:`已保存 ${saved.length} 首，失败 ${failed} 首，取消或未开始 ${cancelled} 首。`});
    }
  }
  cancel(taskId) {
    if (!this.active || this.active.id!==taskId) return this.reject('这次下载已经结束。','STALE_JOB');
    if (this.worker.active) {
      const result=this.worker.cancel(this.worker.active.id);
      if (result.errorCode==='CANCEL_FAILED') return result;
    }
    this.active.cancelled=true;
    return this.publish({phase:'cancelling',message:'正在取消当前歌曲和剩余队列…'});
  }
  setOutputDirectory(directory) {
    if (this.active || this.closed) return this.reject('请先等待当前下载结束。','BUSY');
    const result=this.worker.setOutputDirectory(directory);
    return result.ok ? this.publish({...result,items:[]}) : result;
  }
  async shutdown() {
    this.closed=true;
    const batch=this.active;
    if (batch) { this.cancel(batch.id); await batch.done; }
    await this.worker.shutdown();
  }
}
module.exports={SunoDownloadBatch};
