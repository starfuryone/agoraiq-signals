/* AgoraIQ shared mobile nav — auto-injects hamburger into .topbar nav
   Loaded on every page via /assets/agoraiq-mobile.js
   Idempotent: skips pages that already have their own toggle. */
(function(){
  "use strict";

  function init(){
    var topbar = document.querySelector(".topbar");
    if(!topbar) return;
    var nav = topbar.querySelector("nav");
    var brand = topbar.querySelector(".brand");
    if(!nav || !brand) return;

    // Skip if any hamburger already exists (e.g. pricing.html has its own)
    if(topbar.querySelector(".aiq-nav-toggle, .nav-toggle, [data-nav-toggle]")) return;

    // Build hamburger button
    var btn = document.createElement("button");
    btn.className = "aiq-nav-toggle";
    btn.type = "button";
    btn.setAttribute("aria-label","Menu");
    btn.setAttribute("aria-expanded","false");
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';

    // Insert hamburger right before the nav
    nav.parentNode.insertBefore(btn, nav);

    // Toggle on click
    btn.addEventListener("click", function(e){
      e.stopPropagation();
      var open = nav.classList.toggle("aiq-open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });

    // Tap outside closes
    document.addEventListener("click", function(e){
      if(!nav.classList.contains("aiq-open")) return;
      if(nav.contains(e.target) || btn.contains(e.target)) return;
      nav.classList.remove("aiq-open");
      btn.setAttribute("aria-expanded","false");
    });

    // Tapping a nav link closes
    Array.prototype.forEach.call(nav.querySelectorAll("a"), function(a){
      a.addEventListener("click", function(){
        nav.classList.remove("aiq-open");
        btn.setAttribute("aria-expanded","false");
      });
    });

    // Resize back to desktop closes
    var mql = window.matchMedia("(min-width:901px)");
    var onChange = function(e){
      if(e.matches){
        nav.classList.remove("aiq-open");
        btn.setAttribute("aria-expanded","false");
      }
    };
    if(mql.addEventListener) mql.addEventListener("change", onChange);
    else if(mql.addListener) mql.addListener(onChange);
  }

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
