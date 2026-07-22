/**
 * The login page.
 *
 * Served directly by the dashboard server rather than built with the rest of
 * the stx UI: it has to render before there is a session, and the built pages
 * are scope-specific (see the per-scope UI cache in `local-dashboard-server`).
 * Keeping it self-contained also means a broken UI build still leaves a way in.
 *
 * It mirrors the cockpit's existing design tokens so the two don't read as
 * different products.
 */

const STYLES = `
  :root {
    --bg: #0a0e15; --bg2: #0b0f18; --panel: rgba(255,255,255,0.03); --panel-br: rgba(255,255,255,0.072);
    --txt: #e9edf5; --txt2: #94a1b8; --txt3: #5a6577;
    --accent: #5a8be0; --accent-ink: #061019;
    --bad: #f0736e; --badbg: rgba(240,115,110,0.11);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { background: var(--bg); min-height: 100%; }
  body {
    font-family: 'Inter', system-ui, sans-serif; color: var(--txt); min-height: 100vh;
    background:
      radial-gradient(900px 460px at 88% -8%, rgba(90,139,224,0.06), transparent 62%),
      linear-gradient(175deg, var(--bg), var(--bg2));
    -webkit-font-smoothing: antialiased;
    display: grid; place-items: center; padding: 24px;
  }
  .card {
    width: 100%; max-width: 380px;
    background: var(--panel); border: 1px solid var(--panel-br); border-radius: 16px;
    padding: 32px; backdrop-filter: blur(6px);
    animation: rise .5s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes rise { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
  @media (prefers-reduced-motion: reduce) { .card { animation: none } }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 17px; letter-spacing: -0.02em; }
  .brand .dot { width: 20px; height: 20px; border-radius: 6px; background: var(--accent); box-shadow: inset 0 1px 0 rgba(255,255,255,0.35); }
  h1 { font-size: 21px; font-weight: 800; letter-spacing: -0.02em; margin-top: 22px; }
  .sub { color: var(--txt2); font-size: 13.5px; margin-top: 5px; line-height: 1.5; }
  form { margin-top: 24px; display: grid; gap: 14px; }
  .field { display: flex; flex-direction: column; gap: 7px; }
  label { color: var(--txt3); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.07em; }
  input {
    width: 100%; background: rgba(255,255,255,0.05); border: 1px solid var(--panel-br); border-radius: 10px;
    padding: 10px 12px; color: var(--txt); font-family: inherit; font-size: 14px;
  }
  input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(90,139,224,0.12); }
  button {
    margin-top: 4px; background: var(--accent); color: var(--accent-ink); border: 0; border-radius: 10px;
    padding: 11px 16px; font-weight: 700; font-size: 13.5px; cursor: pointer; font-family: inherit;
    transition: filter .12s, transform .12s;
  }
  button:hover { filter: brightness(1.06); }
  button:active { transform: translateY(1px); }
  button[disabled] { opacity: 0.6; cursor: default; }
  .msg {
    display: none; margin-top: 14px; padding: 10px 12px; border-radius: 10px;
    background: var(--badbg); border: 1px solid rgba(240,115,110,0.22); color: var(--bad);
    font-size: 13px; line-height: 1.45;
  }
  .msg.shown { display: block; }
  .hidden { display: none !important; }
  .note { color: var(--txt3); font-size: 12px; margin-top: 20px; line-height: 1.5; }
  .note code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--txt2); }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .sso { display: grid; gap: 10px; margin-top: 22px; }
  .sso-button { display: block; border: 1px solid var(--panel-br); border-radius: 10px; padding: 11px 14px; color: var(--txt); text-align: center; font-size: 13.5px; font-weight: 700; background: rgba(255,255,255,0.04); }
  .sso-button:hover { border-color: var(--accent); text-decoration: none; }
  .separator { display: flex; align-items: center; gap: 10px; margin: 18px 0 -6px; color: var(--txt3); font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }
  .separator::before, .separator::after { content: ''; height: 1px; flex: 1; background: var(--panel-br); }
`

/**
 * The page. `serverless` only picks the post-login landing route, matching the
 * redirect the server already does for a serverless deployment.
 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

export function renderLoginPage(serverless = false, oidcProviders: readonly { slug: string, name: string }[] = []): string {
  const home = serverless ? '/serverless' : '/'
  const sso = oidcProviders.length > 0
    ? `<div class="sso" aria-label="Single sign-on">${oidcProviders.map(provider => `<a class="sso-button" href="/auth/oidc/${encodeURIComponent(provider.slug)}/start?return=${encodeURIComponent(home)}">Continue with ${escapeHtml(provider.name)}</a>`).join('')}</div><div class="separator"><span>or use local recovery</span></div>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sign in · ts-cloud</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='3' y='3' width='26' height='26' rx='8' fill='%235a8be0'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${STYLES}</style>
</head>
<body>
  <main class="card">
    <div class="brand"><span class="dot"></span> ts-cloud</div>
    <h1>Sign in</h1>
    <p class="sub">Manage the sites you have been given access to.</p>

    ${sso}

    <form id="login" autocomplete="on">
      <div class="field">
        <label for="username">Username</label>
        <input id="username" name="username" autocomplete="username" required autofocus>
      </div>
      <div class="hidden field" id="mfa-field">
        <label for="mfa-code">Authenticator or recovery code</label>
        <input id="mfa-code" name="mfa-code" autocomplete="one-time-code">
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
      </div>
      <button type="submit" id="submit">Sign in</button>
    </form>

    <p class="msg" id="msg" role="alert" aria-live="polite"></p>
    <p class="note"><a href="/forgot-password">Forgot your password?</a></p>
  </main>

<script>
  const form = document.getElementById('login')
  const msg = document.getElementById('msg')
  const submit = document.getElementById('submit')
  const mfaField = document.getElementById('mfa-field')
  const mfaCode = document.getElementById('mfa-code')
  let challengeToken = ''

  if (new URLSearchParams(location.search).has('sso_error')) {
    msg.textContent = 'Single sign-on could not be completed. Try again or use the local recovery path.'
    msg.classList.add('shown')
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    msg.classList.remove('shown')
    submit.disabled = true
    submit.textContent = 'Signing in...'
    try {
      const res = await fetch(challengeToken ? '/api/auth/mfa/complete' : '/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(challengeToken
          ? { challengeToken, code: mfaCode.value }
          : { username: document.getElementById('username').value, password: document.getElementById('password').value }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.ok) throw new Error(body.error || 'Could not sign in.')
      if (body.mfaRequired) {
        challengeToken = body.challengeToken
        mfaField.classList.remove('hidden')
        mfaCode.required = true
        document.getElementById('username').readOnly = true
        document.getElementById('password').readOnly = true
        submit.disabled = false
        submit.textContent = 'Verify and sign in'
        mfaCode.focus()
        return
      }
      location.href = ${JSON.stringify(home)}
    } catch (error) {
      msg.textContent = (error && error.message) || String(error)
      msg.classList.add('shown')
      submit.disabled = false
      submit.textContent = 'Sign in'
      if (challengeToken) {
        mfaCode.value = ''
        mfaCode.focus()
      }
      else {
        document.getElementById('password').value = ''
        document.getElementById('password').focus()
      }
    }
  })
</script>
</body>
</html>`
}

export function renderPasswordRecoveryPage(mode: 'request' | 'reset'): string {
  const reset = mode === 'reset'
  const fields = reset
    ? '<div class="field"><label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required></div><div class="field"><label for="confirmation">Confirm new password</label><input id="confirmation" name="confirmation" type="password" autocomplete="new-password" minlength="12" required></div>'
    : '<div class="field"><label for="identifier">Username or email</label><input id="identifier" name="identifier" autocomplete="username" required autofocus></div>'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${reset ? 'Choose a new password' : 'Recover your account'} · ts-cloud</title>
<style>${STYLES}</style>
</head>
<body>
  <main class="card">
    <div class="brand"><span class="dot"></span> ts-cloud</div>
    <h1>${reset ? 'Choose a new password' : 'Recover your account'}</h1>
    <p class="sub">${reset ? 'This one-time link expires after one hour.' : 'Enter your username or verified email. The response is the same whether or not an account exists.'}</p>
    <form id="recovery" autocomplete="on">
      ${fields}
      <button type="submit" id="submit">${reset ? 'Change password' : 'Send reset link'}</button>
    </form>
    <p class="msg" id="msg" role="status" aria-live="polite"></p>
    <p class="note"><a href="/login">Return to sign in</a></p>
  </main>
<script>
  const form = document.getElementById('recovery')
  const msg = document.getElementById('msg')
  const submit = document.getElementById('submit')
  const reset = ${JSON.stringify(reset)}
  const token = new URLSearchParams(location.search).get('token') || ''
  if (reset && !token) {
    msg.textContent = 'This reset link is missing its token. Request a new link.'
    msg.classList.add('shown')
    submit.disabled = true
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (reset && document.getElementById('password').value !== document.getElementById('confirmation').value) {
      msg.textContent = 'The passwords do not match.'
      msg.classList.add('shown')
      return
    }
    submit.disabled = true
    msg.textContent = reset ? 'Changing password…' : 'Requesting reset link…'
    msg.classList.add('shown')
    const response = await fetch(reset ? '/api/auth/password-reset/complete' : '/api/auth/password-reset/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reset
        ? { token, password: document.getElementById('password').value }
        : { identifier: document.getElementById('identifier').value }),
    })
    const result = await response.json().catch(() => ({}))
    msg.textContent = result.message || result.error || 'The request could not be completed.'
    if (!response.ok) {
      submit.disabled = false
      return
    }
    if (reset)
      setTimeout(() => location.assign('/login'), 1200)
  })
</script>
</body>
</html>`
}
