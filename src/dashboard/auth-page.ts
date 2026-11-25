/** Server-rendered, script-free forms avoid retaining credentials in client state. */
export function authPage(action: 'login' | 'signup', { error, closed = false }: { error?: string; closed?: boolean }) {
  const signup = action === 'signup';
  const title = signup ? 'Set up your workspace' : 'Log in to your workspace';
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0b0b0c">
  <title>${title} · JobAgent</title>
  <link rel="stylesheet" href="/auth.css">
</head>
<body>
  <header><a class="brand" href="/"><span aria-hidden="true">J.</span> JobAgent</a></header>
  <main>
    <div class="card">
      <p class="eyebrow">Private career workspace</p>
      <h1>${title}</h1>
      <p>${closed ? 'This workspace already has an owner. New registrations are closed.' : signup ? 'Create the only owner account for this workspace. You’ll need the setup token from the server administrator.' : 'Enter your owner credentials to open your workspace.'}</p>
      ${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}
      ${closed ? '<a class="button" href="/login">Go to log in</a>' : `
      <form action="/${action}" method="post">
        <label for="email">Email address</label>
        <input id="email" name="email" type="email" maxlength="254" autocomplete="username" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" minlength="12" maxlength="128" autocomplete="${signup ? 'new-password' : 'current-password'}"${signup ? ' aria-describedby="password-hint"' : ''} required>
        ${signup ? `<small id="password-hint">Use at least 12 characters.</small>
        <label for="setup-token">Setup token</label>
        <input id="setup-token" name="setupToken" type="password" maxlength="128" autocomplete="off" required>` : ''}
        <button class="button" type="submit">${signup ? 'Create the owner account' : 'Log in'}</button>
      </form>
      <p class="alt">${signup ? 'Already set up? <a href="/login">Log in</a>' : 'Setting up for the first time? <a href="/signup">Create the owner account</a>'}</p>`}
    </div>
  </main>
</body>
</html>`;
}
