// Address of the Google Apps Script web app (ends with /exec).
// On this computer, opening http://localhost:8741/?mock uses the local test server instead.
window.FR_CONFIG = {
  apiUrl: location.hostname === 'localhost' && location.search.includes('mock')
    ? ''
    : 'https://script.google.com/macros/s/AKfycbz5C5PQkCU45l4nZoDbReEGHaLh8mz7hzwzMvOPv9gnwQu5XC6aYEGm0P0V9YwENUXKHg/exec'
};
