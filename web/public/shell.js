// Interim shell until the React SPA lands. Shows sign-in or the MCP connector URL.
const app = document.getElementById('app');
const res = await fetch('/api/v1/me', { credentials: 'same-origin' });
const wrap = document.createElement('div');
wrap.className = 'c';
const logo = document.createElement('img');
logo.src = '/logo.svg';
logo.width = 40;
logo.alt = '';
wrap.append(logo);
if (res.status === 401) {
  const a = document.createElement('a');
  a.className = 'b';
  a.href = '/auth/login?return_to=' + encodeURIComponent(location.pathname);
  a.textContent = 'Sign in with Microsoft';
  wrap.append(a);
} else if (res.ok) {
  const me = await res.json();
  const who = document.createElement('div');
  who.textContent = me.user.name ?? me.user.email;
  const url = document.createElement('code');
  url.textContent = me.mcp_url;
  wrap.append(who, url);
}
app.append(wrap);
