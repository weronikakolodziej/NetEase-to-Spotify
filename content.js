// content.js — wstrzykiwany na music.163.com
// Pośredniczy w żądaniach do NetEase API (ma dostęp do ciasteczek sesji)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'NETEASE_REQUEST') return;

  const { path, body } = msg;
  const url = `https://music.163.com${path}`;

  const options = {
    method: body ? 'POST' : 'GET',
    credentials: 'include', // wysyła ciasteczka NetEase (sesja użytkownika)
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://music.163.com/',
    }
  };

  if (body) {
    options.body = new URLSearchParams(body).toString();
  }

  fetch(url, options)
    .then(res => res.json())
    .then(data => sendResponse({ data }))
    .catch(err => sendResponse({ error: err.message }));

  return true; // async response
});
