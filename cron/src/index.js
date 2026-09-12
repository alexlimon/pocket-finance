export default {
  async scheduled(_controller, env, _ctx) {
    const res = await fetch(`${env.APP_URL}/api/plaid/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.PF_API_KEY}` },
    });
    if (!res.ok) {
      console.error(`[cron] CC spend sync failed: ${res.status}`, await res.text().catch(() => ''));
    } else {
      console.log(`[cron] CC spend sync ok (${res.status})`);
    }
  },
};
