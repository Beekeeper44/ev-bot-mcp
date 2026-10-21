import base64, json, math
from decimal import Decimal, ROUND_HALF_UP
from playwright.sync_api import sync_playwright
URL="file://" + __import__("os").path.abspath(__import__("os").path.join(__import__("os").path.dirname(__file__), "..", "public", "evbot.html")) + ""
CUTS={"pokemon":[.25,.25,.30,.35],"onepiece":[.35,.40,.40,.40],"sports":[.10,.30,.35,.35]}
BANDS=[(11,21),(21,36),(36,61),(61,1e18)]
FACT={"10":.80,"9.5":1,"9":1,"8.5":1,"8":.90,"7.5":1,"7":1,"6":1}
MARKET={"10":(.80,.80),"9.5":(.70,.85),"9":(.60,.70)}   # Alan's charts with default sources (CGC 10, PSA 9): (TCG, sports), no cut on top
def whole(x): return int(Decimal(str(round(x,2))).quantize(Decimal("1"),rounding=ROUND_HALF_UP))
def cut(v,sp):
    for i,(lo,hi) in enumerate(BANDS):
        if lo<=v<hi: return CUTS[sp][i]
    return 0
def fac(grade,sp): return MARKET[grade][1 if sp=="sports" else 0] if grade in MARKET else FACT[grade]
def new_comp(comp,grade,sp): pre=comp*fac(grade,sp); return whole(pre) if grade in MARKET else whole(pre*(1-cut(pre,sp)))
def recomp(ev,sp): c=cut(ev,sp); return None if c==0 else whole(ev*(1-c))
SPORT={"pokemon":"pokemon","onepiece":"one piece","sports":"basketball"}
results=[]; 
def check(name,got,exp):
    ok=got==exp; results.append(ok); print(("PASS" if ok else "FAIL"),name,"got",got,"expected",exp)
def card(i,sp,ev,grade="10",co="arena club"):
    return dict(item_id=f"00000000-0000-4000-8000-{i:012d}",player_name=f"P{i}",set_name="2024 Set",sport=SPORT.get(sp,sp),grade=f"{co} {grade}",grading_company=co,
      ev=ev,ev_date="2026-10-10",ev_source="approved",ev_age_days=10,last_comp=ev,tag="",status="hidden",set_number=str(i),cert=None,ac=str(i))
with sync_playwright() as p:
  b=p.chromium.launch(); pg=b.new_page(viewport={"width":1300,"height":900})
  pg.goto(URL); pg.wait_for_timeout(600)
  def load(cards,done=(),grid=False):
    pg.evaluate("""([cards,done])=>{ ME={can_write:true,role:'admin',name:'T'}; window.__calls=[];
      api=async(p,b)=>{ window.__calls.push([p,JSON.parse(JSON.stringify(b||{}))]);
        if(p==='find') return {scope:'warehouse',total:cards.length,ms:1,has_filter:true,parsed:{filters:{grading_company:'arena_club'},post_filters:{}},cards,queries:[],target_ev:null,missing:[]};
        if(p==='grid-done') return {marker:'ac grid v1',done};
        if(p==='apply') return {status:'ok',run_id:'r1',results:[],counts:{}}; return {}; };
      S=null; find('arena club'); }""",[cards,list(done)]); pg.wait_for_timeout(600)
    if not grid and pg.evaluate("()=>!!S.grid"): pg.evaluate("()=>toggleGrid()"); pg.wait_for_timeout(200)
  # A. popup examples ($50 comp)
  for g in ["10","9","8","9.5","7"]:
    for sp in CUTS:
      check(f"popup $50 Arena {g} {sp}", pg.evaluate(f"(()=>{{const a=ruleFor('{g}','{sp}'); return arenaCalc(50,a[1],'{sp}',a[2]).to}})()"), new_comp(50,g,sp))
  # B. new comps through the panel value, every grade × sport, several comps
  cs=[]; i=0
  for sp in CUTS:
    for g in ["10","9.5","9","8.5","8","7.5","7","6"]:
      cs.append(card(i,sp,100,g)); i+=1
  load(cs)
  for comp in [8,11.11,15,22,40,45,50,70,100,1000]:
    pg.evaluate(f"()=>{{S.target={comp}; render();}}")
    for c in cs:
      sp=[k for k,v in SPORT.items() if v==c["sport"]][0]; g=c["grade"].split()[-1]
      got=pg.evaluate("id=>evOf(S.rows.find(r=>r.item_id===id))",c["item_id"])
      check(f"new comp ${comp} Arena {g} {sp}",got,new_comp(comp,g,sp))
  check("panel shows what Arena cards submit", pg.evaluate("()=>/Arena 10 Pokémon/.test(document.querySelector('.arenapanel')?.textContent||'')"), True)
  # C/D. re-comp mode: band edges + rounding + skips + payload
  evs=[9.99,10,10.99,11,19.99,20,20.99,21,34.99,35,35.5,36,45,59.99,60,60.99,61,1000]
  rc=[]; i=100
  for sp in CUTS:
    for ev in evs: rc.append(card(i,sp,ev)); i+=1
  done_id=rc[5]["item_id"]                     # pretend this one was already cut
  rc.append(card(999,"pokemon",50,"9","psa"))   # not Arena
  load(rc,[done_id])
  pg.evaluate("()=>{S.note='';}"); pg.click("#gridBtn"); pg.wait_for_timeout(500)
  check("cut is on", pg.evaluate("()=>!!S.grid"), True)
  for c in rc:
    sp=[k for k,v in SPORT.items() if v==c["sport"]][0]; isA="arena" in c["grading_company"]
    exp_sel = isA and c["item_id"]!=done_id and recomp(c["ev"],sp) is not None
    got_sel=pg.evaluate("id=>S.selected.has(id)",c["item_id"])
    check(f"re-comp selected? {c['grading_company']} {sp} ${c['ev']}",got_sel,exp_sel)
    if exp_sel:
      check(f"re-comp EV {sp} ${c['ev']}",pg.evaluate("id=>evOf(S.rows.find(r=>r.item_id===id))",c["item_id"]),recomp(c["ev"],sp))
  check("note gets marker", pg.evaluate("()=>S.note"), "ac grid v1")
  # E. submit payload
  pg.evaluate("()=>{ const sel=S.rows.filter(r=>S.selected.has(r.item_id)); return run(sel,true); }"); pg.wait_for_timeout(800)
  calls=pg.evaluate("()=>window.__calls.filter(c=>c[0]==='apply').map(c=>c[1])")
  check("one apply call",len(calls),1)
  body=calls[0]
  check("payload note has marker","ac grid v1" in body["note"],True)
  check("payload dry run",body["dry_run"],True)
  exp_vals={c["item_id"]:recomp(c["ev"],[k for k,v in SPORT.items() if v==c["sport"]][0]) for c in rc if "arena" in c["grading_company"] and c["item_id"]!=done_id and recomp(c["ev"],[k for k,v in SPORT.items() if v==c["sport"]][0]) is not None}
  got_vals={k:v["ev"] for k,v in body["values"].items()}
  check("payload values = expected cuts",got_vals,exp_vals)
  check("payload item_ids = selected",sorted(body["item_ids"]),sorted(exp_vals))
  # F. tile override in grid mode + toggle off
  load(rc,[])
  pg.click("#gridBtn"); pg.wait_for_timeout(400)
  tid=rc[9]["item_id"]
  pg.evaluate("id=>{S.over.set(id,{ev:'123'}); }",tid)
  check("comp typed on an old-EV tile → comp × Arena % − cut", pg.evaluate("id=>evOf(S.rows.find(r=>r.item_id===id))",tid), new_comp(123,"10","pokemon"))
  pg.click("#gridBtn"); pg.wait_for_timeout(300)
  check("toggle off", pg.evaluate("()=>!!S.grid"), False)
  # G. Arena % off → typed value as-is
  pg.evaluate("()=>{ARENA_ON=false; S.over.clear(); S.target=50; render();}")
  check("Arena % off: $50 stays $50", pg.evaluate("id=>evOf(S.rows.find(r=>r.item_id===id))",rc[0]["item_id"]), 50)
  # J. searching Arena Club turns the cut on by itself; brand-new cards (no EV) get comp × Arena % − cut
  fresh=[card(500,"pokemon",None,"10"),card(501,"onepiece",None,"9"),card(502,"sports",None,"8")]
  for f in fresh: f["last_comp"]=None
  mix=[card(510,"pokemon",50,"10"),card(511,"sports",8,"10")]+fresh
  pg.evaluate("()=>{ARENA_ON=true;}")
  load(mix,[],grid=True)
  check("auto cut on for an Arena search", pg.evaluate("()=>!!S.grid"), True)
  check("old EV $50 Pokémon → $35 with nothing typed", pg.evaluate("id=>evOf(S.rows.find(r=>r.item_id===id))",mix[0]["item_id"]), 35)
  check("old EV $8 skipped", pg.evaluate("id=>S.selected.has(id)",mix[1]["item_id"]), False)
  for f in fresh: check(f"new card {f['sport']} selected", pg.evaluate("id=>S.selected.has(id)",f["item_id"]), True)
  check("new card waits for a comp", pg.evaluate("id=>evOf(S.rows.find(r=>r.item_id===id))",fresh[0]["item_id"]), None)
  check("summary mentions new cards", pg.evaluate("()=>/new — type the comp price/.test(document.querySelector('.gridsum').textContent)"), True)
  pg.evaluate("()=>{S.target=50; render();}")
  for f,(g,sp) in zip(fresh,[("10","pokemon"),("9","onepiece"),("8","sports")]):
    check(f"new {sp} Arena {g}, comp $50", pg.evaluate("id=>evOf(S.rows.find(r=>r.item_id===id))",f["item_id"]), new_comp(50,g,sp))
  check("old EV card ignores the panel comp", pg.evaluate("id=>evOf(S.rows.find(r=>r.item_id===id))",mix[0]["item_id"]), 35)
  pg.evaluate("id=>{S.over.set(id,{ev:'200'}); render();}",fresh[0]["item_id"])
  check("new card: comp typed on tile $200 → Arena 10 Pokémon", pg.evaluate("id=>evOf(S.rows.find(r=>r.item_id===id))",fresh[0]["item_id"]), new_comp(200,"10","pokemon"))
  check("no last comp → not blocked once there's an EV", pg.evaluate("id=>lcMissing(S.rows.find(r=>r.item_id===id))",fresh[1]["item_id"]), False)
  check("no last comp → last comp = new EV", pg.evaluate("id=>{const r=S.rows.find(x=>x.item_id===id); return [lcSend(r),evOf(r)]}",fresh[1]["item_id"]), [new_comp(50,"9","onepiece")]*2)
  pg.evaluate("()=>{S.target=null; S.over.clear(); render();}")
  check("no EV and no last comp → still blocked", pg.evaluate("id=>lcMissing(S.rows.find(r=>r.item_id===id))",fresh[1]["item_id"]), True)
  pg.evaluate("()=>{S.target=50; render();}")
  pg.evaluate("()=>{window.__calls=[]; return run(S.rows.filter(r=>S.selected.has(r.item_id)),true);}"); pg.wait_for_timeout(600)
  vals=pg.evaluate("()=>window.__calls.filter(c=>c[0]==='apply')[0][1].values")
  for f,(g,sp) in zip(fresh,[("10","pokemon"),("9","onepiece"),("8","sports")]):
    v=vals.get(f["item_id"],{})
    check(f"payload: new {sp} EV and last comp filled", [v.get("ev"),v.get("last_comp")], [new_comp(50,g,sp)]*2)
  # popup: Arena 10 source buttons on top, level inputs, formula follows the source
  load(mix,[],grid=True); pg.evaluate("()=>{S.target=50; render();}")
  pg.evaluate("id=>showInfo(id)",fresh[0]["item_id"]); pg.wait_for_timeout(300)
  check("popup has Arena 10 source buttons", pg.evaluate("()=>document.querySelectorAll('#info [data-ac10]').length"), 3)
  tops=pg.evaluate("()=>[document.getElementById('ieEv').getBoundingClientRect().top, document.getElementById('ieLc').getBoundingClientRect().top]")
  check("popup EV and last comp inputs are level", abs(tops[0]-tops[1])<1, True)
  for src,f in [("PSA 10",.50),("CGC Pristine",.55),("CGC 10",.80)]:
    pg.click(f"#info [data-ac10='{src}']"); pg.wait_for_timeout(250)
    exp=whole(50*f)
    check(f"popup {src}: label + value", pg.evaluate("id=>[document.querySelector('#info .infoedit label').textContent.trim().startsWith(AC10_SRC), evOf(S.rows.find(r=>r.item_id===id))]",fresh[0]["item_id"]), [True,exp])
  # last comp fills itself with the EV in the popup (new card, no last comp)
  pg.evaluate("()=>{setAc10('PSA 10');}")
  pg.evaluate("id=>{S.over.delete(id); showInfo(id);}",fresh[0]["item_id"]); pg.wait_for_timeout(300)
  pg.fill("#ieEv","100"); pg.wait_for_timeout(100)
  check("popup: LC auto-fills with the EV ($100 PSA 10 × 50%)", pg.evaluate("()=>document.getElementById('ieLc').value"), "50")
  pg.fill("#ieEv","120"); pg.wait_for_timeout(100)
  check("popup: LC follows the EV", pg.evaluate("()=>document.getElementById('ieLc').value"), "60")
  pg.fill("#ieLc","70"); pg.fill("#ieEv","140"); pg.wait_for_timeout(100)
  check("popup: a typed LC is kept", pg.evaluate("()=>document.getElementById('ieLc').value"), "70")
  pg.evaluate("()=>{setAc10('CGC 10'); document.getElementById('info').close();}")
  # Use CL value → EV goes in as-is
  pg.evaluate("id=>showInfo(id)",fresh[0]["item_id"]); pg.wait_for_timeout(300)
  pg.evaluate("()=>{const iu=document.getElementById('ieClUse'); iu.dataset.v='105'; iu.disabled=false; iu.click();}")
  pg.evaluate("id=>infoSave(id)",fresh[0]["item_id"])
  check("Use CL value → EV: Card Ladder value submits as-is", pg.evaluate("id=>[evOf(S.rows.find(r=>r.item_id===id)),arenaNote(S.rows.find(r=>r.item_id===id))]",fresh[0]["item_id"]), [105,"Card Ladder value, as-is"])
  pg.evaluate("()=>{document.getElementById('ieEv').value='105.5'}"); pg.evaluate("id=>infoSave(id)",fresh[0]["item_id"])
  check("typing over it makes it a comp again", pg.evaluate("id=>evOf(S.rows.find(r=>r.item_id===id))",fresh[0]["item_id"]), new_comp(105.5,"10","pokemon"))
  # Pristine at 55%
  for sp in ["pokemon","onepiece","sports"]:
    check(f"Pristine $100 → $55 ({sp})", pg.evaluate(f"arenaCalc(100,AC10_FACTORS['CGC Pristine'].tcg,'{sp}',true).to"), 55)
  pg.evaluate("()=>document.getElementById('info').close()")
  # K. new comp %s match Alan's Sports and TCG charts ($100 comp)
  CH=[("CGC 10","PSA 9","10","pokemon",80),("CGC Pristine","PSA 9","10","pokemon",55),("PSA 10","PSA 9","10","pokemon",50),("PSA 10","PSA 9","10","sports",60),("CGC 10","PSA 9","10","sports",80),
      ("CGC 10","PSA 9","9.5","pokemon",70),("CGC 10","PSA 9","9.5","sports",85),("CGC 10","PSA 9","9","pokemon",60),("CGC 10","PSA 9","9","sports",70),
      ("CGC 10","CGC 9","9.5","pokemon",90),("CGC 10","CGC 9","9","pokemon",80)]
  for s10,s9,g,sp,exp in CH:
    pg.evaluate(f"()=>{{setAc10('{s10}'); setAc9('{s9}');}}")
    got=pg.evaluate(f"(()=>{{const a=ruleFor('{g}','{sp}'); return [a[0],arenaCalc(100,a[1],'{sp}',a[2]).to]}})()")
    check(f"chart ✓ Arena {g} {sp} off {s10 if g=='10' else s9}: $100 → ${exp}", got, [s10 if g=='10' else s9, exp])
  pg.evaluate("()=>{setAc10('CGC 10'); setAc9('PSA 9');}")
  check("9 source saved", pg.evaluate("()=>localStorage.getItem('evbot_ac9')"), "PSA 9")
  # L. Approve tab: "Mine" by default, "Everyone" for approvers; Approve all sends the scope
  pg.evaluate("""()=>{ ME={can_write:true,can_approve:true,role:'admin',name:'T'}; window.__calls=[];
    const mine=[{run_id:'r1',item_id:'a',label:'1 · Mine card',new_ev:10,submitted_by:'T'}], all=mine.concat([{run_id:'r2',item_id:'b',label:'2 · Other card',new_ev:20,submitted_by:'Jesse'}]);
    api=async(p,b)=>{ window.__calls.push([p,b]); if(p.startsWith('approvals')) return p.includes('scope=all')?all:mine; if(p==='approve') return {approved:1,failed:0,approved_ids:[]}; return {}; };
    try{localStorage.removeItem('evbot_aq')}catch{}; A.scope='mine'; A.rows=[]; document.getElementById('tab-approve').hidden=false; return loadApprovals(); }""")
  pg.wait_for_timeout(300)
  check("Approve tab asks for my queue by default", pg.evaluate("()=>window.__calls.filter(c=>c[0].startsWith('approvals')).pop()[0]"), "approvals?scope=mine")
  check("Mine shows only my card", pg.evaluate("()=>A.rows.map(r=>r.item_id)"), ["a"])
  pg.click('[data-aq="all"]'); pg.wait_for_timeout(300)
  check("Everyone shows the whole queue", pg.evaluate("()=>[window.__calls.filter(c=>c[0].startsWith('approvals')).pop()[0], A.rows.map(r=>r.item_id), localStorage.getItem('evbot_aq')]"), ["approvals?scope=all",["a","b"],"all"])
  pg.click('[data-aq="mine"]'); pg.wait_for_timeout(300)
  check("back to Mine", pg.evaluate("()=>A.rows.map(r=>r.item_id)"), ["a"])
  pg.evaluate("()=>{ME.can_approve=false; A.scope='all'; return loadApprovals();}"); pg.wait_for_timeout(300)
  check("non-approvers always get their own queue", pg.evaluate("()=>[window.__calls.filter(c=>c[0].startsWith('approvals')).pop()[0], !!document.querySelector('[data-aq]')]"), ["approvals?scope=mine", False])
  pg.evaluate("()=>{ME.can_approve=true; A.scope='mine'; document.getElementById('tab-approve').hidden=true;}")
  # H. popup renders with deck wording
  pg.evaluate("()=>{ARENA_ON=true; document.getElementById('arRules').click()}"); pg.wait_for_timeout(300)
  txt=pg.evaluate("()=>document.querySelector('dialog[open]').textContent")
  for phrase in ["EV = comp × % (no cut)","EV = comp × Arena % − cut","Cut, by sport and value","Arena 9.5 / 9 priced off"]:
    check(f"popup says: {phrase}", phrase in txt, True)
  # I. Arena 10 comp source picker
  check("default Arena 10 source", pg.evaluate("()=>AC10_SRC"), "CGC 10")
  for src in ["CGC Pristine","PSA 10","CGC 10"]:
    pg.click(f"dialog[open] [data-ac10='{src}']"); pg.wait_for_timeout(250)
    check(f"picked {src}", pg.evaluate("()=>[AC10_SRC, ARENA_MAP.get('10')[0], localStorage.getItem('evbot_ac10')]"), [src,src,src])
    t2=pg.evaluate("()=>document.querySelector('dialog[open]').textContent")
    check(f"popup row shows {src}", f"Arena 10{src}" in t2.replace("\n","").replace(" ","").replace(src.replace(" ",""),src) or src in t2, True)
    FT={"CGC 10":(.80,.80),"CGC Pristine":(.55,.55),"PSA 10":(.50,.60)}[src]
    for sp in ["pokemon","onepiece","sports"]:
      F=FT[1] if sp=="sports" else FT[0]
      check(f"{src} {sp} $100 comp = market", pg.evaluate(f"(()=>{{const a=ruleFor('10','{sp}'); return arenaCalc(100,a[1],'{sp}',a[2]).to}})()"), whole(100*F))
      check(f"{src} {sp} rule", pg.evaluate(f"ruleFor('10','{sp}')"), [src,F,True])
  pg.query_selector("dialog[open]").screenshot(path="arena_percentage_new.png")
  b.close()
print(f"\n{sum(results)}/{len(results)} passed")
