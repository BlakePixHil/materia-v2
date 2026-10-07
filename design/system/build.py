#!/usr/bin/env python3
"""Builds the materia design system (v2).

Outputs
  design/system/project/...           the design-system file tree (tokens.json, components/*, assets/*)
  design/tokens/materia.tokens.css    the same tokens as CSS custom properties, for the Angular app
  design/mockups/screens.html         standalone page of every screen, tokens and styles inlined

Run: python3 design/system/build.py
"""
import json
import shutil
from pathlib import Path

import components
import components_next  # noqa: F401  (registers second-pass components)
import components_lit  # noqa: F401  (registers litigation components)
import components_pass4  # noqa: F401  (registers fourth-pass components, DES-01)
import components_pwa  # noqa: F401  (registers the installable app's components, MOB-01)
import components_tours  # noqa: F401  (registers the guided tour, CORE-24)
import screens
import screens_next
import screens_lit
import screens_settings
import screens_pass4
import screens_connector
import tokens
from icons import ICONS, icon_file

HERE = Path(__file__).resolve().parent
PROJECT = HERE / "project"
REPO_DESIGN = HERE.parent
# Logos were copied from the legacy app (src/assets/logos) into design/assets/logos for v2.
LOGOS = REPO_DESIGN / "assets" / "logos"

# Rendered heights of each screen at 1440px (measured by check.cjs; update when a screen changes a lot).
SCREEN_HEIGHTS = json.loads((HERE / "screen-heights.json").read_text()) if (HERE / "screen-heights.json").exists() else {}

SCREEN_DIRS = {"Today": "TodayScreen", "Matter": "MatterScreen", "Matters list": "MattersListScreen", "Matters board": "MattersBoardScreen",
               "Deadlines": "DeadlinesScreen", "Time and billing": "BillingScreen", "New matter intake": "IntakeScreen", "Command palette": "CommandPaletteScreen",
               "Insights": "InsightsScreen", "Contacts": "ContactsScreen", "Settings": "SettingsScreen",
               "Onboarding": "OnboardingScreen", "Mobile": "MobileScreen",
               "Disputes": "DisputesScreen", "Dispute matter": "DisputeMatterScreen", "Chronology and evidence": "ChronologyScreen",
               "Settlement and costs": "SettlementScreen", "Court book": "CourtBookScreen",
               "Settings: Team and roles": "SettingsTeamScreen", "Settings: Billing and rates": "SettingsBillingScreen", "Settings: Practice": "SettingsPracticeScreen",
               "Settings: Trust account": "SettingsTrustScreen", "Settings: Integrations": "SettingsIntegrationsScreen", "Settings: Security": "SettingsSecurityScreen",
               "Settings: Audit log": "SettingsAuditScreen",
               "Inbox": "InboxScreen", "Inbox: unfiled email": "UnfiledEmailScreen", "Notifications": "NotificationsScreen",
               "Clerk": "ClerkScreen", "Tablet: Today": "TabletTodayScreen", "Tablet: Matter": "TabletMatterScreen",
               "Tablet: Matters list": "TabletMattersListScreen", "System states": "SystemStatesScreen",
               "Settings: Claude connector": "SettingsClaudeConnectorScreen", "Connect Claude": "ConnectClaudeScreen"}
screens.SCREENS += screens_lit.SCREENS + screens_next.SCREENS + screens_settings.SCREENS + screens_pass4.SCREENS + screens_connector.SCREENS


def write(rel, text):
    p = PROJECT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def cover():
    return """<!-- @dsCard height=288 -->
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Cover</title>
<style>
  html, body { margin: 0; background: var(--bg-surface); }
  .cv { position: relative; width: 960px; height: 288px; overflow: hidden; font-family: var(--font-sans); }
  .cv svg { position: absolute; inset: 0; }
  .brand { fill: var(--blue-500); } .ink { fill: var(--bg-inverse); } .clerk { fill: var(--violet-500); }
  .tint { fill: var(--blue-100); } .spark { fill: var(--orange-400); } .dot { fill: var(--blue-300); }
  .r-lg { rx: var(--radius-lg); } .r-md { rx: var(--radius-md); } .r-full { rx: 16px; }
  .txt { position: absolute; left: 40px; bottom: 36px; max-width: 440px; }
  .name { font-family: var(--font-sans); font-size: 96px; line-height: .92; font-weight: 600; letter-spacing: -0.045em; color: var(--text-primary); }
  .tag { margin-top: 16px; font-size: 14px; line-height: 20px; color: var(--text-tertiary); }
</style></head>
<body>
<div class="cv">
<svg viewBox="0 0 960 288" width="960" height="288" aria-hidden="true">
  <!-- blocks: blue-500 256x192 (brand), bg-inverse 128x248 (ink, flips in dark), violet-500 128x96 (Clerk), blue-100 176x64 (tint), orange-400 32 disc (Clerk gradient end)
       arrangement: a staggered modular stack right of x=480, brand slab bleeding off the top, ink slab bleeding off the right and bottom, like the inset panel beside the sidebar
       pattern: "precise, technical, mono, a 4px grid" -> a 7x7 dot grid at space-16 pitch cut into the ink slab, the README's keyboard-first, Linear-like tone
       scales: space-16 pitch and gaps, space-32 offsets, radius-lg slabs, radius-md tint, radius-full disc -->
  <rect class="brand r-lg" x="560" y="-12" width="256" height="196"/>
  <rect class="ink r-lg" x="832" y="48" width="140" height="252"/>
  <rect class="clerk r-lg" x="688" y="200" width="128" height="100"/>
  <rect class="tint r-md" x="496" y="200" width="176" height="64"/>
  <rect class="spark r-full" x="832" y="0" width="32" height="32"/>
""" + "\n".join(f'  <circle class="dot" cx="{856 + c * 16}" cy="{80 + r * 16}" r="1.6"/>' for r in range(7) for c in range(7)) + """
</svg>
<div class="txt"><div class="name">materia</div><div class="tag">Practice software for Wills &amp; Estates lawyers, with Clerk built in.</div></div>
</div>
</body>
</html>
"""


def screen_preview(name, desc, fn):
    h = SCREEN_HEIGHTS.get(name, 900)
    return (f'<!-- @dsCard group="Screens" height={h} width=1440 page subtitle="{desc}" -->\n<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>{name}</title>'
            f'<style>html,body{{margin:0;background:var(--bg-canvas)}}</style></head>\n<body>\n{fn()}\n</body>\n</html>\n')


def standalone(tokens_css, bundle_css, bundle_js):
    shots = "".join(f'<section class="shot" id="{SCREEN_DIRS[n]}"><div class="shot-h"><h2>{n}</h2><p>{d}</p></div><div class="stage">{fn()}</div></section>' for n, d, fn in screens.SCREENS)
    toc = "".join(f'<a href="#{SCREEN_DIRS[n]}">{n}</a>' for n, _, _ in screens.SCREENS)
    page_css = """
/* Layout: a gallery of 1440px app frames, scaled to the column width. */
body.gallery{background:var(--bg-canvas);padding-inline:clamp(16px,3vw,40px);padding-block:32px 64px;margin:0}
.g-head{max-width:1440px;margin:0 auto 20px;display:flex;flex-wrap:wrap;gap:16px 24px;align-items:flex-end}
.g-head .lead{flex:1 1 520px;min-width:0}
.g-head h1{font:600 32px/38px var(--font-sans);letter-spacing:-.025em;margin:6px 0 8px;text-wrap:balance;color:var(--text-primary)}
.g-head p{margin:0;max-width:68ch;color:var(--text-secondary);font:400 15px/24px var(--font-sans)}
.g-head a{color:var(--text-brand)}
.toc{max-width:1440px;margin:0 auto 28px;display:flex;flex-wrap:wrap;gap:6px}
.toc a{font:500 12px/16px var(--font-sans);text-decoration:none;color:var(--text-secondary);height:28px;display:inline-flex;align-items:center;padding:0 10px;border:1px solid var(--border-default);border-radius:999px;background:var(--bg-surface)}
.toc a:hover{color:var(--text-primary);border-color:var(--border-strong)}
.zoom{display:inline-flex;padding:2px;border-radius:6px;background:var(--bg-sunken)}
.zoom button{font:500 12px/16px var(--font-sans);border:0;background:none;color:var(--text-secondary);height:24px;padding:0 10px;border-radius:4px;cursor:pointer}
.zoom button[aria-pressed="true"]{background:var(--bg-surface);color:var(--text-primary);box-shadow:var(--shadow-control),0 0 0 1px var(--border-default)}
.zoom button:focus-visible{outline:none;box-shadow:var(--focus-ring)}
.shot{max-width:1440px;margin:0 auto 48px}
.shot-h{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:baseline;margin-bottom:12px}
.shot-h h2{font:600 18px/24px var(--font-sans);letter-spacing:-.015em;margin:0;color:var(--text-primary)}
.shot-h p{margin:0;color:var(--text-tertiary);font:400 13px/18px var(--font-sans);flex:1 1 360px;min-width:0}
.stage{overflow-x:auto;border-radius:16px;box-shadow:var(--shadow-dialog);background:var(--bg-canvas)}
.stage.fit{overflow:hidden}
.stage>.mt{transform-origin:0 0}
"""
    js = """
(function(){var st=[].slice.call(document.querySelectorAll('.stage')),fit=true;
try{if(localStorage.getItem('mt-fit')==='0')fit=false}catch(e){}
function size(){st.forEach(function(s){var a=s.firstElementChild;var k=fit?Math.min(1,s.clientWidth/1440):1;a.style.transform=k<1?'scale('+k+')':'none';s.style.height=Math.ceil(a.offsetHeight*k)+'px';s.classList.toggle('fit',fit)});
[].forEach.call(document.querySelectorAll('.zoom button'),function(b){b.setAttribute('aria-pressed',String((b.dataset.fit==='1')===fit))})}
[].forEach.call(document.querySelectorAll('.zoom button'),function(b){b.addEventListener('click',function(){fit=b.dataset.fit==='1';try{localStorage.setItem('mt-fit',fit?'1':'0')}catch(e){}size()})});
if(window.ResizeObserver)new ResizeObserver(size).observe(document.body);else addEventListener('resize',size);size()})();
"""
    return f"""<title>materia Screens v2</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<style>
{bundle_css}
{tokens_css}
{page_css}
</style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<script>document.body && document.body.classList.add('gallery');</script>
<header class="g-head mt"><div class="lead"><div class="eyebrow t-3">materia · Wills &amp; Estates · design v2</div>
<h1>{len(screens.SCREENS)} screens for the AI-native practice</h1>
<p>Built from the <a href="https://claude.ai/artifact/QQ8WDbjwa4QTjSRkL6TfRm" target="_blank" rel="noopener">materia design system</a>: Geist, a cool slate canvas, #346CFC as the one action colour, and violet reserved for Clerk. Follows your light or dark setting. People, matters and figures are fictional; deadline rules are illustrative and need practitioner review.</p></div>
<div class="zoom" role="group" aria-label="Zoom"><button type="button" data-fit="1" aria-pressed="true">Fit</button><button type="button" data-fit="0" aria-pressed="false">Actual size</button></div></header>
<nav class="toc">{toc}</nav>
{shots}
<script>document.body.classList.add('gallery');{bundle_js.split('*/', 2)[-1]}{js}</script>
"""


def build():
    # tokens
    tj = tokens.tokens_json()
    write("tokens.json", json.dumps(tj, indent=2, ensure_ascii=False) + "\n")
    tokens_css = tokens.tokens_css(system_pref=True)
    (REPO_DESIGN / "tokens").mkdir(exist_ok=True)
    (REPO_DESIGN / "tokens" / "materia.tokens.css").write_text(tokens.tokens_css(system_pref=True, font_base="../system/project/fonts/"))

    # components (remove folders for anything no longer in the catalogue)
    keep = {c["name"] for c in components.C} | set(SCREEN_DIRS.values()) | {"Cover"}
    for d in (PROJECT / "components").iterdir():
        if d.is_dir() and d.name not in keep and d.name != "lib":
            shutil.rmtree(d)
            print("removed", d.name)
    for c in components.C:
        write(f"components/{c['name']}/README.md", c["readme"])
        write(f"components/{c['name']}/preview.html", components.preview(c))
    for name, desc, fn in screens.SCREENS:
        d = SCREEN_DIRS[name]
        write(f"components/{d}/preview.html", screen_preview(name, desc, fn))
        write(f"components/{d}/README.md", f"# {d}\n\n{desc}\n\nComposed only from materia components and tokens; see each component's guidelines for the parts.\n")
    write("components/Cover/preview.html", cover())

    # asset group READMEs and icon files (icons are uploaded as assets; files kept locally for upload)
    write("assets/Icons/README.md", "Lucide line icons (ISC licence) at 24px with a 1.6 stroke, rendered at 16px in the UI. These files use slate-600 #5A5F6C as their single ink; in the app, icons are inline SVG with `stroke: currentColor` so they take `icon-*` tokens.\n")
    write("assets/Logos/README.md", "The existing materia marks, copied unchanged from the legacy app. Pillar mark and wordmark ink: logo blue #0364B8 (black-logo: blue on light; white-logo: white wordmark for dark grounds). The square app icons are #323232 (m_ terminal mark) and white with a blue pillar.\n")
    icon_dir = HERE / "upload" / "Icons"
    icon_dir.mkdir(parents=True, exist_ok=True)
    for n in ICONS:
        (icon_dir / f"{n}.svg").write_text(icon_file(n))
    logo_dir = HERE / "upload" / "Logos"
    logo_dir.mkdir(parents=True, exist_ok=True)
    for f in ["black-logo.svg", "white-logo.svg", "square-black-logo.svg", "square-white-logo.svg"]:
        shutil.copy(LOGOS / f, logo_dir / f)

    # standalone screens page
    bundle_css = (PROJECT / "components" / "bundle.css").read_text()
    bundle_js = (PROJECT / "components" / "bundle.js").read_text()
    (REPO_DESIGN / "mockups").mkdir(exist_ok=True)
    (REPO_DESIGN / "mockups" / "screens.html").write_text(standalone(tokens_css, bundle_css, bundle_js))
    print(f"components: {len(components.C)} · screens: {len(screens.SCREENS)} · colors: {len(tj['color']['tokens'])} · icons: {len(ICONS)}")


if __name__ == "__main__":
    build()
