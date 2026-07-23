import { openAs, APPS } from '../../lib.mjs';
for (const role of ['org_admin', 'read_only']) {
  const { browser, page } = await openAs(role);
  const visited = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) visited.push(f.url()); });
  await page.goto(APPS['lookup-admin'] + '/dashboard', { waitUntil: 'domcontentloaded' }).catch((e) => visited.push('ERR:' + e.message.split('\n')[0]));
  await page.waitForTimeout(2500);
  const body = await page.locator('body').innerText().catch(() => '');
  const loop = visited.filter((u) => /login/.test(u)).length;
  console.log(`${role.padEnd(12)} final=${page.url()}`);
  console.log(`   navs=${visited.length} loginBounces=${loop} forbiddenShown=${/Access restricted/i.test(body)} tooManyRedirects=${/ERR_TOO_MANY_REDIRECTS/.test(visited.join())}`);
  await browser.close();
}
