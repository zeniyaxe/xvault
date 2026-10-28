import json,time,subprocess,shutil,pathlib,threading,urllib.parse,secrets,hmac,re,os,copy
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
BASE=pathlib.Path(__file__).resolve().parent; CFG=BASE/'config.json'; LOG=BASE/'helper.log'; STATE_FILE=BASE/'.xvault-state.json'; TOKEN_FILE=BASE/'.xvault-token'
STATE={'started_at':time.time(),'watching':'','ffmpeg':None,'last_error':None,'last_conversion':None,'active':0,'converted':0,'failed':0,'conversions':{}}
CANCEL_REQUESTS=set(); ACTIVE_PROCESSES={}; STATE_LOCK=threading.RLock()
def auth_token():
 try:
  if TOKEN_FILE.exists(): return TOKEN_FILE.read_text(encoding='utf-8').strip()
  token=secrets.token_urlsafe(32); TOKEN_FILE.write_text(token,encoding='utf-8'); return token
 except Exception as e: STATE['last_error']=f'auth: {e}'; return ''
def rotate_token():
 token=secrets.token_urlsafe(32); TOKEN_FILE.write_text(token,encoding='utf-8'); return token
def stable_job_id(value):
 h=2166136261
 data=str(value).encode('utf-16-le')
 for i in range(0,len(data),2):
  h=((h^(data[i]|data[i+1]<<8))*16777619)&0xffffffff
 return f'xvconv-{h:08x}'
def load_state():
 changed=False
 try:
  if STATE_FILE.exists():
   saved=json.loads(STATE_FILE.read_text(encoding='utf-8')); STATE['converted']=int(saved.get('converted',0)); STATE['failed']=int(saved.get('failed',0)); STATE['last_conversion']=saved.get('last_conversion'); STATE['conversions']=saved.get('conversions',{}) if isinstance(saved.get('conversions',{}),dict) else {}
   for key,row in STATE['conversions'].items():
    if not isinstance(row,dict):continue
    if row.get('state') in ('converting','running','cancel-requested'):
     row['state']='interrupted';row['finished']=time.time();row['error']='Helper restarted before conversion finished';changed=True
    for label in ('gif','webp'):
     descriptor=row.get(label)
     if not isinstance(descriptor,dict) or descriptor.get('state')!='removing':continue
     source=None
     try:
      cfg=load_cfg();candidate,source,error=safe_derivative_target(row,label,cfg)
      if error:raise ValueError(error)
      if candidate.exists() and candidate.is_file():state='ready'
      elif not candidate.exists():state='removed'
      else:state='verification-unavailable'
      descriptor['state']=state
      if state=='removed':descriptor['removedAt']=time.time();descriptor.pop('removeRequestedAt',None)
      elif state=='ready':descriptor.pop('removeRequestedAt',None)
      else:descriptor['error']='The pending output path could not be verified after restart'
      events=row.get('derivativeEvents') if isinstance(row.get('derivativeEvents'),list) else []
      events.append({'action':'remove-recovered' if state=='removed' else 'remove-interrupted' if state=='ready' else 'remove-unverified','format':label,'at':time.time(),'state':state,'sourcePreserved':True})
      row['derivativeEvents']=events[-100:];row['updatedAt']=time.time();changed=True
     except Exception as e:
      descriptor['state']='verification-unavailable';descriptor['error']=f'Pending removal recovery failed: {e}'[:300];changed=True
      events=row.get('derivativeEvents') if isinstance(row.get('derivativeEvents'),list) else []
      events.append({'action':'remove-unverified','format':label,'at':time.time(),'state':'verification-unavailable','sourcePreserved':bool(source and source.is_file())})
      row['derivativeEvents']=events[-100:];row['updatedAt']=time.time()
   if changed:persist_state()
 except Exception as e: STATE['last_error']=f'state: {e}'
def persist_state():
 with STATE_LOCK:
  try:
   payload={k:STATE[k] for k in ('converted','failed','last_conversion','conversions')}; payload['conversions']=dict(list(payload['conversions'].items())[-300:]); tmp=STATE_FILE.with_suffix('.tmp')
   with tmp.open('w',encoding='utf-8') as stream:json.dump(payload,stream,ensure_ascii=False);stream.flush();os.fsync(stream.fileno())
   tmp.replace(STATE_FILE);return True
  except Exception as e: STATE['last_error']=f'state write: {e}';return False
def log(msg):
 line=f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n"; LOG.open('a',encoding='utf-8').write(line); print(line,end='',flush=True)
def defaults(): return {'downloads_root':str(pathlib.Path.home()/'Downloads'),'xvault_folder':'XVault','extension_id':'','fps':20,'max_width':1280,'webp_quality':90,'poll_seconds':1.2,'make_gif':True,'make_webp':True,'delete_source':False,'original_folder':'Originals','gif_folder':'GIFs','gif_output_folder':'GIF','webp_output_folder':'WebP','server_port':17843,'max_concurrency':1}
def load_cfg():
 d=defaults()
 if CFG.exists():
  try:d.update(json.loads(CFG.read_text(encoding='utf-8-sig')))
  except Exception as e:STATE['last_error']=f'config.json: {e}';log('CONFIG ERROR: '+str(e))
 return d
def allowed_extension_origin(origin):
 extension_id=str(load_cfg().get('extension_id') or '').strip()
 return bool(re.fullmatch(r'[a-p]{32}',extension_id) and hmac.compare_digest(str(origin or ''),f'chrome-extension://{extension_id}'))
def ffmpeg_path():
 p=BASE/'ffmpeg.exe';return str(p) if p.exists() else shutil.which('ffmpeg')
def output_paths(src,cfg):
 parts=list(src.parts);low=[x.lower() for x in parts]
 try:gi=low.index(str(cfg.get('gif_folder','GIFs')).lower())
 except ValueError:return None,None
 if gi+1<len(parts) and parts[gi+1].lower()==str(cfg.get('original_folder','Originals')).lower():del parts[gi+1]
 base=pathlib.Path(*parts).with_suffix('');gp=list(base.parts);gp.insert(gi+1,str(cfg.get('gif_output_folder','GIF')));gif=pathlib.Path(*gp).with_suffix('.gif');wp=list(base.parts);wp.insert(gi+1,str(cfg.get('webp_output_folder','WebP')));webp=pathlib.Path(*wp).with_suffix('.webp');return gif,webp
def remove_conversion_output(job_id,label,cfg=None):
    label=str(label or '').lower()
    if label not in ('gif','webp'):
        return {'ok':False,'state':'rejected','error':'Only generated GIF or WebP files can be removed'}
    with STATE_LOCK:
        found=next(((key,item) for key,item in STATE.get('conversions',{}).items() if isinstance(item,dict) and hmac.compare_digest(str(item.get('jobId') or ''),str(job_id or ''))),None)
        if not found:
            return {'ok':False,'state':'not-found','error':'Conversion job not found'}
        state_key,row=found
        if row.get('state') in ('queued','running','cancel-requested') or isinstance(row.get(label),dict) and row[label].get('state')=='removing':
            return {'ok':False,'state':'busy','error':'Wait for the conversion or previous removal to finish before removing an output'}
        cfg=cfg or load_cfg()
        candidate,source,error=safe_derivative_target(row,label,cfg)
        if error:
            return {'ok':False,'state':'rejected','error':f'{error}; no file was removed'}
        descriptor=row.get(label) if isinstance(row.get(label),dict) else {}
        if candidate.exists() and not candidate.is_file():
            return {'ok':False,'state':'rejected','error':'The selected derivative is not a regular file'}
        if not candidate.exists():
            row[label]={**descriptor,'state':'missing','path':str(candidate)}
            row['updatedAt']=time.time()
            persisted=persist_state()
            return {'ok':True,'state':'missing','format':label,'originalPreserved':True,'statePersisted':persisted}
        try:
            initial_stat=candidate.stat()
            identity=(initial_stat.st_dev,initial_stat.st_ino,initial_stat.st_size,getattr(initial_stat,'st_mtime_ns',int(initial_stat.st_mtime*1_000_000_000)))
        except OSError as error:
            return {'ok':False,'state':'verification-unavailable','error':f'The generated file could not be inspected: {error}'}
        size=initial_stat.st_size
        now=time.time()
        original=copy.deepcopy(row)
        row[label]={**descriptor,'state':'removing','path':str(candidate),'size':size,'removeRequestedAt':now}
        history=row.get('derivativeEvents') if isinstance(row.get('derivativeEvents'),list) else []
        row['derivativeEvents']=([*history,{'action':'remove-requested','format':label,'at':now,'size':size,'sourcePreserved':True}])[-100:]
        row['updatedAt']=now
        if not persist_state():
            STATE['conversions'][state_key]=original
            return {'ok':False,'state':'journal-failed','error':'The removal intent could not be recorded; the generated file was left untouched'}
        checked,checked_source,check_error=safe_derivative_target(row,label,cfg)
        try:
            current_stat=checked.stat() if checked and not check_error else None
            current_identity=(current_stat.st_dev,current_stat.st_ino,current_stat.st_size,getattr(current_stat,'st_mtime_ns',int(current_stat.st_mtime*1_000_000_000))) if current_stat else None
        except OSError:
            current_identity=None
        if (check_error or not checked or checked.resolve(strict=False)!=candidate.resolve(strict=False) or
            candidate.is_symlink() or current_identity!=identity):
            reason=check_error or 'The recorded output changed while removal was being prepared'
            row[label]={**descriptor,'state':'missing' if not candidate.exists() else 'verification-unavailable','path':str(candidate),'error':reason}
            history=row.get('derivativeEvents') if isinstance(row.get('derivativeEvents'),list) else []
            row['derivativeEvents']=([*history,{'action':'remove-aborted','format':label,'at':time.time(),'state':row[label]['state'],'sourcePreserved':bool(checked_source and checked_source.is_file())}])[-100:]
            row['updatedAt']=time.time()
            persist_state()
            return {'ok':False,'state':'changed','error':'The generated file changed after the removal preview; it was left untouched'}
        try:
            candidate.unlink()
        except OSError as error:
            STATE['conversions'][state_key]=original
            persist_state()
            return {'ok':False,'state':'remove-failed','error':f'The generated file could not be removed: {error}'}
        now=time.time()
        row[label]={**row[label],'state':'removed','removedAt':now}
        row[label].pop('removeRequestedAt',None)
        history=row.get('derivativeEvents') if isinstance(row.get('derivativeEvents'),list) else []
        row['derivativeEvents']=([*history,{'action':'remove','format':label,'at':now,'size':size,'sourcePreserved':True}])[-100:]
        row['updatedAt']=now
        persisted=persist_state()
        return {'ok':True,'state':'removed','format':label,'size':size,'originalPreserved':True,'statePersisted':persisted,'warning':None if persisted else 'The file was removed. Its saved intent will be reconciled when the helper restarts.'}
def resolve_source(raw):
 root=pathlib.Path(STATE.get('watching') or '').resolve();p=pathlib.Path(str(raw or ''))
 if not p.is_absolute():
  # Chrome filenames include the configured root (XVault/foo); helper paths
  # without it are interpreted relative to the watched root.
  p=(root.parent/p if p.parts and p.parts[0].lower()==root.name.lower() else root/p)
 try:
  p=p.resolve();p.relative_to(root);return p
 except Exception:return None
def safe_derivative_target(row,label,cfg):
 try:
  if label not in ('gif','webp'):return None,None,'Only generated GIF or WebP files can be verified'
  configured_root=pathlib.Path(cfg['downloads_root'])/cfg.get('xvault_folder','XVault')
  root=pathlib.Path(STATE.get('watching') or configured_root).resolve()
  raw_source=str(row.get('input') or row.get('key') or '')
  source=pathlib.Path(raw_source)
  if not source.is_absolute():source=(root.parent/source if source.parts and source.parts[0].casefold()==root.name.casefold() else root/source)
  source=source.resolve(strict=False)
  source.relative_to(root)
  if not source.is_file() or source.suffix.lower() not in ('.mp4','.webm'):
   return None,None,'The archival video source cannot be verified'
  output=output_paths(source,cfg)[0 if label=='gif' else 1]
  if not output:return None,None,'The configured derivative path is unavailable'
  folder_key='gif_output_folder' if label=='gif' else 'webp_output_folder'
  default_folder='GIF' if label=='gif' else 'WebP'
  folder=str(cfg.get(folder_key,default_folder));original=str(cfg.get('original_folder','Originals'))
  if (not folder or folder in ('.','..') or '/' in folder or '\\' in folder or
      folder.casefold()==original.casefold() or output.parent.name.casefold()!=folder.casefold() or
      output.parent.resolve()==source.parent.resolve() or output.suffix.lower()!=f'.{label}'):
   return None,None,'The configured path is not a separate generated derivative folder'
  expected=output.resolve(strict=False)
  expected.relative_to(root)
  if expected==source.resolve(strict=False):return None,None,'The selected path resolves to the archival source'
  parent=output.parent
  while parent!=root and parent.is_relative_to(root):
   if parent.is_symlink():return None,None,'A derivative folder is a symbolic link'
   parent=parent.parent
  if parent!=root:return None,None,'The derivative folder escaped the XVault archive root'
  descriptor=row.get(label) if isinstance(row.get(label),dict) else {}
  recorded=descriptor.get('path') or row.get(f'{label}Path')
  if not recorded:return None,None,'This output is not recorded as an XVault derivative'
  recorded_path=pathlib.Path(str(recorded))
  if not recorded_path.is_absolute():recorded_path=root/recorded_path
  recorded_path=recorded_path.resolve(strict=False)
  recorded_path.relative_to(root)
  if recorded_path!=expected or output.is_symlink():return None,None,'The recorded output no longer matches its safe derivative path'
  return output,source,None
 except (OSError,ValueError) as error:
  return None,None,f'The derivative path cannot be verified: {error}'
def verify_output(path,label):
 try:
  if not path.is_file() or path.stat().st_size<100:return False,'Output is missing, empty, or implausibly small'
  with path.open('rb') as stream: head=stream.read(16)
  if label.upper()=='GIF' and head[:6] not in (b'GIF87a',b'GIF89a'):return False,'GIF output has an invalid signature'
  if label.upper()=='WEBP' and not (head[:4]==b'RIFF' and head[8:12]==b'WEBP'):return False,'WebP output has an invalid signature'
  return True,''
 except OSError as e:return False,f'Output could not be inspected: {e}'
def run(cmd,tmp,dst,label,key,job_id):
 try:
  p=subprocess.Popen(cmd,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
  with STATE_LOCK:ACTIVE_PROCESSES[job_id]=p
  while p.poll() is None:
   with STATE_LOCK:cancelled=job_id in CANCEL_REQUESTS
   if cancelled:
    p.terminate();
    try:p.wait(timeout=3)
    except subprocess.TimeoutExpired:p.kill()
    raise RuntimeError('cancelled')
   time.sleep(.25)
  stderr=p.stderr.read() if p.stderr else ''
  valid,reason=verify_output(tmp,label)
  if p.returncode or not valid: raise RuntimeError((stderr or reason or f'exit {p.returncode}')[-800:])
  dst.parent.mkdir(parents=True,exist_ok=True);tmp.replace(dst)
  with STATE_LOCK:STATE['conversions'][key][label.lower()]={'state':'ready','path':str(dst),'size':dst.stat().st_size};STATE['conversions'][key]['progress']=.5;persist_state()
  return True
 except Exception as e:
  state='cancelled' if str(e)=='cancelled' else 'failed'
  with STATE_LOCK:STATE['conversions'][key][label.lower()]={'state':state,'error':str(e)};STATE['last_error']=str(e);persist_state()
  tmp.unlink(missing_ok=True);return False
 finally:
  with STATE_LOCK:ACTIVE_PROCESSES.pop(job_id,None)
def convert(src,cfg):
 ff=ffmpeg_path();key=str(src);gif,webp=output_paths(src,cfg)
 if not ff or not gif:
  STATE['last_error']='FFmpeg unavailable' if not ff else 'Source is outside the configured animation folder'
  return False
 job_id=stable_job_id(key)
 with STATE_LOCK:
  existing=STATE['conversions'].get(key)
  if existing and existing.get('state') in ('queued','running','cancel-requested'):return False
  STATE['active']+=1;STATE['conversions'][key]={'key':key,'jobId':job_id,'input':key,'state':'running','started':time.time(),'gifPath':str(gif),'webpPath':str(webp),'requestedGif':bool(cfg.get('make_gif',True)),'requestedWebP':bool(cfg.get('make_webp',True)),'progress':0};persist_state()
 try:
  fps=max(5,min(60,int(cfg.get('fps',20))));width=max(320,min(4096,int(cfg.get('max_width',1280))));quality=max(1,min(100,int(cfg.get('webp_quality',90))));ok=[]
  if cfg.get('make_gif',True):
   gif.parent.mkdir(parents=True,exist_ok=True);tmp=gif.with_suffix('.xvault.tmp.gif');vf=f"fps={fps},scale='min({width},iw)':-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle";ok.append(run([ff,'-hide_banner','-loglevel','error','-y','-i',str(src),'-filter_complex',vf,'-loop','0',str(tmp)],tmp,gif,'GIF',key,job_id))
  if cfg.get('make_webp',True):
   webp.parent.mkdir(parents=True,exist_ok=True);tmp=webp.with_suffix('.xvault.tmp.webp');vf=f"fps={fps},scale='min({width},iw)':-2:flags=lanczos";q=max(1,round((100-quality)*.63)+5);ok.append(run([ff,'-hide_banner','-loglevel','error','-y','-i',str(src),'-vf',vf,'-an','-c:v','libwebp_anim','-loop','0','-q:v',str(q),'-compression_level','4',str(tmp)],tmp,webp,'WebP',key,job_id))
  with STATE_LOCK:
   cancelled=job_id in CANCEL_REQUESTS;CANCEL_REQUESTS.discard(job_id);good=bool(ok) and all(ok) and not cancelled;STATE['conversions'][key]['state']='cancelled' if cancelled else ('completed' if good else 'failed');STATE['conversions'][key]['progress']=1 if good else STATE['conversions'][key].get('progress',0);STATE['conversions'][key]['finished']=time.time();STATE['last_conversion']=STATE['conversions'][key];STATE['converted']+=int(good);STATE['failed']+=int(not good and not cancelled);persist_state()
  # The source is archival evidence. Never remove it as a side effect of conversion.
  return good
 finally:
  with STATE_LOCK:STATE['active']=max(0,STATE['active']-1);persist_state()
def stable_file(p,seen):
 try:st=p.stat();sig=(st.st_size,int(st.st_mtime))
 except OSError:return False
 old=seen.get(str(p));seen[str(p)]=sig;return old==sig and st.st_size>0
class API(BaseHTTPRequestHandler):
 def sendj(self,obj,code=200):
  b=json.dumps(obj,ensure_ascii=False).encode();self.send_response(code);self.send_header('Content-Type','application/json');origin=self.headers.get('Origin','')
  if allowed_extension_origin(origin):self.send_header('Access-Control-Allow-Origin',origin);self.send_header('Vary','Origin')
  self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
 def extension_origin(self): return allowed_extension_origin(self.headers.get('Origin',''))
 def authorized(self):
  supplied=self.headers.get('Authorization','');expected=f'Bearer {auth_token()}';return bool(supplied and hmac.compare_digest(supplied,expected))
 def allowed(self,bootstrap=False): return self.extension_origin() if bootstrap else self.authorized()
 def do_GET(self):
  u=urllib.parse.urlparse(self.path);q=urllib.parse.parse_qs(u.query)
  if u.path=='/bootstrap': return self.sendj({'ok':True,'token':auth_token()},200) if self.allowed(True) else self.sendj({'error':'Extension origin required'},403)
  if u.path!='/media' and not self.allowed(): return self.sendj({'error':'Authentication required'},401)
  if u.path=='/media' and not self.authorized(): return self.sendj({'error':'Authentication required'},401)
  if u.path=='/status':
   with STATE_LOCK:status={'connected':True,'version':'16.0','ffmpeg':STATE['ffmpeg'],'watching':STATE['watching'],'active':STATE['active'],'converted':STATE['converted'],'failed':STATE['failed'],'lastError':STATE['last_error'],'lastConversion':copy.deepcopy(STATE['last_conversion'])}
   return self.sendj(status)
  if u.path=='/conversions':
   key=(q.get('key')or[''])[0]
   with STATE_LOCK:rows=[copy.deepcopy(STATE['conversions'][key])] if key in STATE['conversions'] else copy.deepcopy(list(STATE['conversions'].values())[-100:]);ffmpeg=bool(STATE['ffmpeg'])
   return self.sendj({'rows':rows,'ffmpeg':ffmpeg})
  if u.path=='/media':
   p=resolve_source((q.get('path')or[''])[0])
   if not p:return self.sendj({'error':'Path outside XVault root'},403)
   if not p.is_file():return self.sendj({'error':'Not found'},404)
   data=p.read_bytes();self.send_response(200);self.send_header('Access-Control-Allow-Origin',self.headers.get('Origin','null'));self.send_header('Vary','Origin');self.send_header('Cache-Control','no-store');self.send_header('Content-Type','image/gif' if p.suffix.lower()=='.gif' else 'image/webp' if p.suffix.lower()=='.webp' else 'application/octet-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);return
  self.sendj({'error':'Not found'},404)
 def do_POST(self):
  if not self.authorized(): return self.sendj({'error':'Authentication required'},401)
  if int(self.headers.get('Content-Length','0') or 0)>16384:return self.sendj({'error':'Request too large'},413)
  try: body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0') or 0)) or b'{}')
  except:return self.sendj({'error':'Malformed JSON'},400)
  u=urllib.parse.urlparse(self.path)
  if u.path=='/auth/rotate':
   token=rotate_token();return self.sendj({'ok':True,'token':token})
  if u.path=='/conversions/queue':
   raw=str(body.get('path') or '');src=resolve_source(raw)
   if not src or src.suffix.lower() not in ('.mp4','.webm'):return self.sendj({'error':'Invalid conversion source path'},403)
   key=str(src);requested_gif=bool(body.get('requestedGif',True));requested_webp=bool(body.get('requestedWebP',True))
   if not requested_gif and not requested_webp:return self.sendj({'ok':True,'state':'skipped','reason':'No derivative requested'})
   with STATE_LOCK:
    existing=STATE['conversions'].get(key)
    if existing and existing.get('state') in ('queued','running','cancel-requested'):
     response={'ok':True,'jobId':existing.get('jobId'),'state':existing.get('state'),'deduplicated':True}
    else:
     job_id=stable_job_id(key);STATE['conversions'][key]={'key':key,'jobId':job_id,'input':key,'state':'queued','started':None,'requestedGif':requested_gif,'requestedWebP':requested_webp,'keepSource':bool(body.get('keepSource',True)),'fps':int(body.get('fps') or 20),'maxWidth':int(body.get('maxWidth') or 1280),'webpQuality':int(body.get('webpQuality') or 90),'progress':0};persist_state();response={'ok':True,'jobId':job_id,'state':'queued'}
    return self.sendj(response)
  if u.path=='/conversions/remove-output':
   result=remove_conversion_output(body.get('jobId'),body.get('format'),load_cfg())
   return self.sendj(result,200 if result.get('ok') else (404 if result.get('state')=='not-found' else 409))
  if u.path!='/conversions/cancel':return self.sendj({'error':'Not found'},404)
  job_id=str(body.get('jobId') or '');
  if not job_id:return self.sendj({'error':'jobId required'},400)
  with STATE_LOCK:
   CANCEL_REQUESTS.add(job_id);row=next((x for x in STATE['conversions'].values() if x.get('jobId')==job_id),None)
   if row:row['state']='cancel-requested';row['cancelRequested']=time.time();persist_state()
  return self.sendj({'ok':True,'jobId':job_id,'state':'cancel-requested'})
 def do_OPTIONS(self):
  self.send_response(204);self.send_header('Access-Control-Allow-Origin',self.headers.get('Origin','null'));self.send_header('Access-Control-Allow-Headers','Authorization, Content-Type');self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS');self.end_headers()
 def log_message(self,*a):pass
def api_thread(cfg):
 port=int(cfg.get('server_port',17843));srv=ThreadingHTTPServer(('127.0.0.1',port),API);log(f'Local bridge: http://127.0.0.1:{port}');srv.serve_forever()
def main():
    load_state()
    cfg=load_cfg()
    root=pathlib.Path(cfg['downloads_root'])/cfg.get('xvault_folder','XVault')
    with STATE_LOCK:
        STATE['watching']=str(root)
        STATE['ffmpeg']=ffmpeg_path()
    log(f'XVault Animation Helper watching: {root}')
    log(f'FFmpeg: {STATE["ffmpeg"] or "NOT FOUND"}')
    threading.Thread(target=api_thread,args=(cfg,),daemon=True).start()
    seen={}
    done=set()
    while True:
        cfg=load_cfg()
        try:
            # Explicit extension-planned jobs win over the legacy folder watcher.
            # This preserves per-job GIF/WebP choices while retaining polling compatibility.
            with STATE_LOCK:
                conversion_rows=[(key,copy.deepcopy(row)) for key,row in STATE['conversions'].items() if isinstance(row,dict)]
            for key,row in conversion_rows:
                if row.get('state') not in ('queued','interrupted'):
                    continue
                src=pathlib.Path(key)
                if not src.is_file() or not stable_file(src,seen):
                    continue
                job_cfg=dict(cfg,make_gif=bool(row.get('requestedGif',cfg.get('make_gif',True))),make_webp=bool(row.get('requestedWebP',cfg.get('make_webp',True))),fps=int(row.get('fps') or cfg.get('fps',20)),max_width=int(row.get('maxWidth') or cfg.get('max_width',1280)),webp_quality=int(row.get('webpQuality') or cfg.get('webp_quality',90)))
                convert(src,job_cfg)
            for src in (root.rglob('*') if root.exists() else []):
                if not src.is_file() or src.suffix.lower() not in ('.mp4','.webm'):
                    continue
                if not any(x.lower()==str(cfg.get('original_folder','Originals')).lower() for x in src.parts):
                    continue
                gif,webp=output_paths(src,cfg)
                key=str(src)
                wanted=[]
                if cfg.get('make_gif',True):
                    wanted.append(gif)
                if cfg.get('make_webp',True):
                    wanted.append(webp)
                if wanted and all(p and p.exists() and p.stat().st_size>100 and p.stat().st_mtime>=src.stat().st_mtime for p in wanted):
                    done.add(key)
                    continue
                if key in done or not stable_file(src,seen):
                    continue
                with STATE_LOCK:
                    existing=copy.deepcopy(STATE['conversions'].get(key))
                job_cfg=dict(cfg,make_gif=bool(existing.get('requestedGif',cfg.get('make_gif',True))) if existing else cfg.get('make_gif',True),make_webp=bool(existing.get('requestedWebP',cfg.get('make_webp',True))) if existing else cfg.get('make_webp',True),fps=int(existing.get('fps') or cfg.get('fps',20)) if existing else cfg.get('fps',20),max_width=int(existing.get('maxWidth') or cfg.get('max_width',1280)) if existing else cfg.get('max_width',1280),webp_quality=int(existing.get('webpQuality') or cfg.get('webp_quality',90)) if existing else cfg.get('webp_quality',90))
                if convert(src,job_cfg):
                    done.add(key)
        except KeyboardInterrupt:
            break
        except Exception as e:
            with STATE_LOCK:
                STATE['last_error']=str(e)
                persist_state()
            log(f'Watcher error: {e}')
        time.sleep(max(.5,float(cfg.get('poll_seconds',1.2))))
if __name__=='__main__':main()
