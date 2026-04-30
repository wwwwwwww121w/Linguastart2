"""Generate Play Store screenshots from the actual app rendered in Chromium."""
import os
import asyncio
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(ROOT, 'LinguaStart_v3.html')
STORE = os.path.join(ROOT, 'store', 'screenshots')
os.makedirs(STORE, exist_ok=True)


async def shoot(page, name):
    await asyncio.sleep(0.5)
    await page.screenshot(path=os.path.join(STORE, name + '.png'), omit_background=False)
    print(f"  → {name}.png")


async def goto_and_setup(page):
    await page.goto('file://' + HTML)
    # bypass login: pretend we have prefs done + user logged in
    await page.evaluate(
        """() => {
            localStorage.setItem('ls_prefs_v1', JSON.stringify({
                done:true,goal:'travel',minutes:10,primary:'en',level:'A1',quizScore:3,reminderOn:true,reminderHour:19
            }));
            localStorage.setItem('ls_progress', JSON.stringify({
                en:['greetings','numbers','colors','family'], ar:['alphabet1','alphabet2']
            }));
            localStorage.setItem('ls_srs_v1', JSON.stringify([
                {k:'en:family:0',lang:'en',topic:'family',wordIdx:0,word:'father',ef:2.5,interval:0,reps:0,due:Date.now()-1000,lapses:1},
                {k:'en:family:1',lang:'en',topic:'family',wordIdx:1,word:'mother',ef:2.5,interval:0,reps:0,due:Date.now()-1000,lapses:1},
                {k:'en:colors:2',lang:'en',topic:'colors',wordIdx:2,word:'green',ef:2.5,interval:0,reps:0,due:Date.now()-1000,lapses:1}
            ]));
        }"""
    )
    await page.reload()
    # auto-login as guest
    await page.evaluate(
        """() => {
            user = {name:'Алексей', type:'login', login:'alex'};
            xp = 245; streak = 7; lessons = 6;
            afterAuth();
        }"""
    )
    await asyncio.sleep(0.6)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={'width': 412, 'height': 869}, device_scale_factor=2.5)
        page = await ctx.new_page()

        await goto_and_setup(page)

        # 1) Home
        await shoot(page, '01-home')

        # 2) Lessons EN
        await page.evaluate("navTo('lessons-en')")
        await shoot(page, '02-lessons-en')

        # 3) Lesson quiz screen
        await page.evaluate("startLesson('en','colors')")
        await shoot(page, '03-quiz')

        # 4) Profile (with voice picker, settings, errors)
        await page.evaluate("navTo('profile'); window.scrollTo(0,0)")
        await shoot(page, '04-profile')

        # 5) Tier list / leaderboard
        await page.evaluate("navTo('tierlist')")
        await shoot(page, '05-leaderboard')

        # 6) Onboarding step
        await page.evaluate("startOnboarding(); onbStep=1; renderOnb();")
        await shoot(page, '06-onboarding')

        # 7) Lessons AR
        await page.evaluate("navTo('lessons-ar')")
        await shoot(page, '07-lessons-ar')

        # 8) Profile scrolled to error analysis
        await page.evaluate("navTo('profile'); window.scrollTo(0, document.body.scrollHeight/2)")
        await shoot(page, '08-recommendations')

        await browser.close()


if __name__ == '__main__':
    asyncio.run(main())
