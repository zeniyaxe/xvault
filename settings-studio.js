/* Settings groups that bind to the shared settings object through data-xv-setting: motion and x.com. */
(() => {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  let state = {};

  const set = async patch => {
    const response = await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', settings: patch });
    state = response?.settings || { ...state, ...patch };
    applyStudio();
    try { settings = state; apply(); sync(); tab({ type: 'XV_REFRESH_INSTANT_SETTINGS' }).catch(() => {}); flashSaved(); } catch {}
    return state;
  };

  const applyStudio = () => {
    for (const element of $$('[data-xv-setting]')) {
      const value = state[element.dataset.xvSetting];
      if (element.type === 'checkbox') element.checked = !!value;
      else if (value != null) element.value = String(value);
    }
    for (const button of $$('[data-xv-setting-value]')) {
      const level = state.animations === false ? 'off' : state[button.dataset.xvSettingValue];
      const active = level === button.dataset.xvValue;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    }
    window.XVaultPaintRanges?.();
  };
  window.XVaultSettingsChanged = value => { state = value; applyStudio(); };

  const motion = `<div class="seg motionLevels" role="radiogroup" aria-label="Animation level">${[['off', 'Off'], ['reduced', 'Reduced'], ['subtle', 'Subtle'], ['normal', 'Normal'], ['rich', 'Rich'], ['extreme', 'Extreme']].map(([value, label]) => `<button type="button" role="radio" data-xv-setting-value="motionLevel" data-xv-value="${value}">${label}</button>`).join('')}</div>
<div class="formgrid two"><label class="field"><span>Animation speed</span><input type="range" min="0.35" max="2" step="0.05" data-xv-setting="motionSpeed"></label></div>
<div class="toggles">
<label><span><b>Reduce motion</b><small>Replaces movement with fades in the dashboard and on x.com.</small></span><input type="checkbox" data-xv-setting="reducedMotion"></label>
<label><span><b>Safe mode</b><small>Turns off rich motion without changing your saved choices.</small></span><input type="checkbox" data-xv-setting="safeMode"></label>
</div>
<div class="advancedOnly"><div class="formgrid two"><label class="field"><span>Spring expression on x.com</span><input type="range" min="0" max="2" step="0.05" data-xv-setting="motionSpring"></label><label class="field"><span>Hover intensity on x.com</span><input type="range" min="0" max="2" step="0.05" data-xv-setting="motionHover"></label></div>
<div class="toggles"><label><span><b>Ambient motion on x.com</b></span><input type="checkbox" data-xv-setting="motionBackground"></label></div></div>`;

  const integration = `<h3>Enhancements</h3><p class="settingHint">Copy Link is the only always-visible addition we recommend. Everything else is optional, and archiving keeps working when this is off.</p>
<div class="toggles">
<label class="recommended"><span><b>Enable XVault on x.com</b></span><input type="checkbox" data-xv-setting="xIntegrationEnabled"></label>
<label class="recommended"><span><b>Copy Link</b><small>Copies a clean, canonical link to the post.</small></span><input type="checkbox" data-xv-setting="xCopyLinkEnabled"></label>
<label><span><b>Power menu</b><small>Archive and copy actions beside each post.</small></span><input type="checkbox" data-xv-setting="xPowerMenuEnabled"></label>
<label><span><b>Archive button</b></span><input type="checkbox" data-xv-setting="xArchiveButtonEnabled"></label>
<label><span><b>Modifier-click actions</b><small>Shift, Alt and middle-click on Copy Link.</small></span><input type="checkbox" data-xv-setting="xModifierActions"></label>
</div>`;
  const links = `<h3>Copied links</h3>
<div class="formgrid two">
<label class="field"><span>Link domain</span><select data-xv-setting="linkProvider"><option value="fixvx">FixVX (default)</option><option value="fixupx">FixupX</option><option value="fxtwitter">FxTwitter</option><option value="vxtwitter">VXTwitter</option><option value="x">x.com</option><option value="twitter">twitter.com</option><option value="custom">Custom domain</option></select></label>
<label class="field"><span>Custom domain</span><input data-xv-setting="customLinkHost" placeholder="example.com"></label>
<label class="field"><span>Button visibility</span><select data-xv-setting="copyButtonVisibility"><option value="always">Always</option><option value="hover">On post hover</option></select></label>
<label class="field"><span>Confirmation lasts (ms)</span><input type="number" min="300" max="5000" step="50" data-xv-setting="copySuccessDuration"></label>
</div>
<div class="toggles">
<label><span><b>Strip tracking parameters</b></span><input type="checkbox" data-xv-setting="copyStripTracking"></label>
<label><span><b>Keep relevant query parameters</b></span><input type="checkbox" data-xv-setting="copyPreserveQuery"></label>
<label><span><b>Show a toast when copied</b></span><input type="checkbox" data-xv-setting="copyToast"></label>
</div>`;
  const cleanup = `<h3>Quieter x.com</h3><p class="settingHint">Each filter is opt-in and turns itself off if X changes its page structure.</p>
<div class="toggles">
<label><span><b>Hide promoted posts</b></span><input type="checkbox" data-xv-setting="xHidePromoted"></label>
<label><span><b>Hide Trends and Who to follow</b></span><input type="checkbox" data-xv-setting="xHideTrends"></label>
<label><span><b>Hide Grok and Premium prompts</b></span><input type="checkbox" data-xv-setting="xHideGrok"></label>
<label><span><b>Compact post spacing</b></span><input type="checkbox" data-xv-setting="xCompactPosts"></label>
</div>`;

  const group = (id, html) => {
    const section = document.createElement('section');
    section.className = 'settinggroup';
    section.id = id;
    section.innerHTML = html;
    return section;
  };

  const render = () => {
    const motionSlot = $('#motionSlot');
    if (motionSlot && !$('#xv-motion-settings')) {
      const container = group('xv-motion-settings', motion);
      container.classList.add('inline');
      motionSlot.replaceWith(...container.childNodes);
    }
    const xSlot = $('#xSlot');
    if (xSlot && !$('#xv-integration-settings')) {
      xSlot.replaceWith(group('xv-integration-settings', integration), group('xv-links-settings', links), group('xv-cleanup-settings', cleanup));
    }
    for (const element of $$('[data-xv-setting]:not([data-xv-bound])')) {
      element.dataset.xvBound = '1';
      element.addEventListener('change', () => set({ [element.dataset.xvSetting]: element.type === 'checkbox' ? element.checked : element.type === 'number' || element.type === 'range' ? Number(element.value) : element.value }));
    }
    for (const button of $$('[data-xv-setting-value]:not([data-xv-bound])')) {
      button.dataset.xvBound = '1';
      button.onclick = () => {
        const key = button.dataset.xvSettingValue, value = button.dataset.xvValue;
        set(key === 'motionLevel' ? { motionLevel: value, animations: value !== 'off' } : { [key]: value });
      };
    }
    applyStudio();
  };

  const ready = () => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }).then(response => { state = response?.settings || {}; render(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
})();
