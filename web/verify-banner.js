/**
 * Email verification banner.
 *
 * Renders a sticky top banner on authenticated pages when the user's
 * email hasn't been verified yet. A user who isn't verified cannot have
 * a cold-visitor Stripe subscription activated automatically — the
 * webhook defers their activation. This banner gives them a one-tap
 * "send me a verification link" action that flips the flag once they
 * click the link, and then unblocks any parked subscription.
 *
 * Contract with the API:
 *   GET  /api/v1/auth/me           -> { user: { emailVerified, ... } }
 *   POST /api/v1/auth/verify/request -> { ok, alreadyVerified }
 *
 * Drop-in: <script src="verify-banner.js" defer></script>
 * No-op if:
 *   - no iq_token in localStorage
 *   - /auth/me returns emailVerified=true
 *   - user has dismissed the banner in this browser session
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  var API = "/api/v1";
  var DISMISS_KEY = "verifyBannerDismissed";

  var token;
  try { token = localStorage.getItem("iq_token"); } catch (_e) { token = null; }
  if (!token) return;

  try {
    if (sessionStorage.getItem(DISMISS_KEY) === "1") return;
  } catch (_e) {}

  function authHeaders() {
    return { "Authorization": "Bearer " + token, "Content-Type": "application/json" };
  }

  function insertBanner(email) {
    if (document.getElementById("aq-verify-banner")) return;

    var bar = document.createElement("div");
    bar.id = "aq-verify-banner";
    bar.setAttribute("role", "status");
    bar.style.cssText = [
      "position:sticky",
      "top:0",
      "left:0",
      "right:0",
      "z-index:9999",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "gap:14px",
      "padding:10px 16px",
      "background:rgba(245,158,11,.12)",
      "border-bottom:1px solid rgba(245,158,11,.35)",
      "color:#f59e0b",
      "font-family:'Albert Sans',system-ui,-apple-system,sans-serif",
      "font-size:13px",
      "line-height:1.45",
      "text-align:center",
      "flex-wrap:wrap",
    ].join(";");

    var msg = document.createElement("span");
    msg.textContent =
      "Verify your email" +
      (email ? " (" + email + ") " : " ") +
      "to activate paid features and receive billing confirmations.";
    msg.style.cssText = "color:#f59e0b;max-width:640px";

    var sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.id = "aq-verify-send";
    sendBtn.textContent = "Send verification email";
    sendBtn.style.cssText = [
      "background:#f59e0b",
      "color:#08090d",
      "border:none",
      "border-radius:6px",
      "padding:7px 14px",
      "font-weight:600",
      "font-size:12px",
      "cursor:pointer",
      "font-family:inherit",
    ].join(";");

    var status = document.createElement("span");
    status.id = "aq-verify-status";
    status.style.cssText = "min-width:0;color:#f59e0b;font-size:12px";

    var close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "\u00d7"; // ×
    close.style.cssText = [
      "background:transparent",
      "color:#f59e0b",
      "border:none",
      "font-size:18px",
      "line-height:1",
      "cursor:pointer",
      "padding:0 4px",
      "margin-left:auto",
    ].join(";");
    close.addEventListener("click", function () {
      try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch (_e) {}
      bar.remove();
    });

    sendBtn.addEventListener("click", function () {
      sendBtn.disabled = true;
      var orig = sendBtn.textContent;
      sendBtn.textContent = "Sending\u2026";
      status.textContent = "";
      fetch(API + "/auth/verify/request", {
        method: "POST",
        headers: authHeaders(),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (!res.ok) {
            status.textContent = (res.data && res.data.error) || "Couldn't send. Try again.";
            sendBtn.disabled = false;
            sendBtn.textContent = orig;
            return;
          }
          if (res.data && res.data.alreadyVerified) {
            status.textContent = "Already verified — thanks!";
            setTimeout(function () { bar.remove(); }, 1500);
            return;
          }
          status.textContent = "Check your inbox for the verification link.";
          sendBtn.textContent = "Resend";
          sendBtn.disabled = false;
        })
        .catch(function () {
          status.textContent = "Network error. Try again.";
          sendBtn.disabled = false;
          sendBtn.textContent = orig;
        });
    });

    bar.appendChild(msg);
    bar.appendChild(sendBtn);
    bar.appendChild(status);
    bar.appendChild(close);

    if (document.body) {
      document.body.insertBefore(bar, document.body.firstChild);
    }
  }

  function boot() {
    fetch(API + "/auth/me", { headers: authHeaders() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.user) return;
        if (d.user.emailVerified) return;
        insertBanner(d.user.email || "");
      })
      .catch(function () {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
