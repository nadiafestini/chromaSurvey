// Niente script inline: la CSP accetta solo questo file.
(function () {
  "use strict";

  // Tema chiaro/scuro: resta in un cookie tecnico così il server lo applica subito.
  document.querySelectorAll("[data-theme-toggle]").forEach(function (button) {
    button.addEventListener("click", function () {
      var next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      var secure = location.protocol === "https:" ? "; Secure" : "";
      document.cookie = "cs_theme=" + next + "; Path=/; Max-Age=31536000; SameSite=Lax" + secure;
    });
  });

  // Massimo risposte e opzione "None" esclusiva.
  function syncMulti(fieldset) {
    var max = Number(fieldset.dataset.max) || Infinity;
    var none = fieldset.dataset.none;
    var boxes = Array.prototype.slice.call(fieldset.querySelectorAll('input[type="checkbox"]'));
    var checked = boxes.filter(function (b) { return b.checked; });
    var noneChecked = checked.some(function (b) { return b.value === none; });
    boxes.forEach(function (b) {
      var isNone = b.value === none;
      var off = noneChecked ? !isNone : (!b.checked && (checked.length >= max || (isNone && checked.length > 0)));
      b.disabled = off;
      b.closest("label").classList.toggle("is-disabled", off);
    });
  }
  document.querySelectorAll("[data-multi]").forEach(function (fieldset) {
    fieldset.addEventListener("change", function () { syncMulti(fieldset); });
    syncMulti(fieldset);
  });

  // Salvataggio automatico delle risposte.
  var form = document.querySelector("[data-survey]");
  if (form) {
    var state = form.querySelector("[data-save-state]");
    var timer = null;
    var pending = false;
    var save = function () {
      window.clearTimeout(timer);
      timer = null;
      if (!pending) return Promise.resolve();
      pending = false;
      return fetch("/survey/save", { method: "POST", body: new FormData(form), credentials: "same-origin" }).then(function (res) {
        if (state) state.textContent = res.ok ? state.dataset.saved : "";
      }).catch(function () {
        if (state) state.textContent = "";
      });
    };
    var schedule = function () {
      pending = true;
      if (state) state.textContent = "";
      window.clearTimeout(timer);
      timer = window.setTimeout(save, 400);
    };
    form.addEventListener("change", schedule);
    form.addEventListener("input", schedule);

    // Cambio lingua: le risposte vengono salvate prima di ricaricare la pagina.
    document.querySelectorAll("[data-lang-form]").forEach(function (langForm) {
      langForm.addEventListener("submit", function (event) {
        event.preventDefault();
        var submitter = event.submitter;
        var data = new FormData(langForm);
        if (submitter && submitter.name) data.set(submitter.name, submitter.value);
        save().then(function () {
          var hidden = document.createElement("input");
          hidden.type = "hidden";
          hidden.name = "lang";
          hidden.value = data.get("lang");
          langForm.appendChild(hidden);
          langForm.submit();
        });
      });
    });
  }
})();
