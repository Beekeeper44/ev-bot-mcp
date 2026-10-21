from playwright.sync_api import sync_playwright
U=[("Aaron Adrianne Joaquin","ajoaquin@precisionlabeling.com","approver","2026-10-14T21:59:00Z"),("Alan Bailey","alan@arenaclub.com","admin",None),
   ("Gino Policarpio","gino@precisionlabeling.com","approver","2026-10-21T22:10:00Z"),("Jensen Manalastas","jensen@precisionlabeling.com","approver","2026-10-08T22:36:00Z"),
   ("Josh Sacramento","joshuary@precisionlabeling.com","approver","2026-10-13T21:47:00Z"),("Kaity Paul","kaity.paul@arenaclub.com","admin","2026-10-02T17:08:00Z"),
   ("Sumit Kharche","skharche@arenaclub.com","approver","2026-10-14T08:39:00Z")]
users=[dict(id=f"u{i}",name=n,email=e,role=r,admin_user_id="x",admin_email=e,active=True,team_view=(n=="Gino Policarpio"),has_password=True,has_mcp_key=False,last_login_at=l) for i,(n,e,r,l) in enumerate(U)]
res=[]
def check(name,got,exp): ok=got==exp; res.append(ok); print("PASS" if ok else "FAIL",name,got if not ok else "")
with sync_playwright() as p:
  b=p.chromium.launch(); pg=b.new_page(viewport={"width":1300,"height":800})
  pg.goto("file://" + __import__("os").path.abspath(__import__("os").path.join(__import__("os").path.dirname(__file__), "..", "public", "evbot.html")) + ""); pg.wait_for_timeout(500)
  pg.evaluate("document.documentElement.setAttribute('data-theme','dark')")
  pg.evaluate("""users=>{ try{localStorage.removeItem('evbot_ucols');localStorage.removeItem('evbot_usort')}catch{}; U.order=UDEF.slice(); U.sort=null;
    ME={id:'u1',is_admin:true,full_access:true,can_approve:true,can_team:true,name:'Alan Bailey'}; window.__posts=[];
    api=async(p)=>p==='users'?JSON.parse(JSON.stringify(users)):{}; post=async(p,b)=>{window.__posts.push([p,b]); return {ok:true};};
    document.querySelectorAll('[id^=tab-]').forEach(t=>t.hidden=true); document.getElementById('tab-account').hidden=false; document.getElementById('tab-users').hidden=false; return renderUsers(); }""",users)
  pg.wait_for_timeout(500)
  heads=lambda: pg.evaluate("()=>[...document.querySelectorAll('#usersTbl th')].map(t=>t.textContent.replace(/[⋮▲▼↕]/g,'').trim())")
  check("headers (User renamed, team queue added)", heads(), ["User","role","team queue","admin login","status","last sign-in",""])
  pg.screenshot(path="users_1_default.png",clip={"x":0,"y":0,"width":1300,"height":800},full_page=True)
  names=lambda: pg.evaluate("()=>[...document.querySelectorAll('#usersTbl tr[data-id] td:first-child b')].map(b=>b.textContent)")
  pg.click("th[data-col=role]"); pg.wait_for_timeout(200)
  check("sort role ▲: admins first", names()[:2], ["Alan Bailey","Kaity Paul"])
  pg.click("th[data-col=role]"); pg.wait_for_timeout(200)
  check("sort role ▼: admins last", names()[-2:], ["Alan Bailey","Kaity Paul"])
  pg.click("th[data-col=user]"); pg.wait_for_timeout(200)
  check("sort User A→Z", names()[0], "Aaron Adrianne Joaquin")
  pg.drag_and_drop("th[data-col=role]","th[data-col=user]"); pg.wait_for_timeout(300)
  check("drag role before User", heads()[:2], ["role","User"])
  check("column order saved", pg.evaluate("()=>JSON.parse(localStorage.getItem('evbot_ucols')).slice(0,2)"), ["role","user"])
  # team switch
  pg.evaluate("()=>{ U.order=UDEF.slice(); drawUsers(); }"); pg.wait_for_timeout(200)
  row=pg.query_selector("tr[data-id=u4] .tswitch")  # Josh
  row.click(); pg.wait_for_timeout(300)
  check("Team switch sends team_view:true", pg.evaluate("()=>window.__posts.pop()"), ["users-update",{"id":"u4","team_view":True}])
  check("admins show 'always'", pg.evaluate("()=>document.querySelector('tr[data-id=u1] .tswitch i').textContent"), "always")
  pg.click("th[data-col=role]"); pg.wait_for_timeout(200)
  pg.screenshot(path="users_2_sorted_role.png",clip={"x":0,"y":0,"width":1300,"height":800},full_page=True)
  # Approve tab labels
  pg.evaluate("""()=>{ api=async(p)=>p.startsWith('approvals')?[]:{}; document.getElementById('tab-approve').hidden=false; A.rows=[]; return loadApprovals(); }"""); pg.wait_for_timeout(300)
  check("Approve toggle says Me / Team", pg.evaluate("()=>[...document.querySelectorAll('[data-aq]')].map(b=>b.textContent)"), ["Me","Team"])
  pg.evaluate("()=>{ ME.can_team=false; return loadApprovals(); }"); pg.wait_for_timeout(300)
  check("member with Team off: no toggle", pg.evaluate("()=>document.querySelectorAll('[data-aq]').length"), 0)
  b.close()
print(f"{sum(res)}/{len(res)} passed")
