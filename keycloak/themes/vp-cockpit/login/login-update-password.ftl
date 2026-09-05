<#-- keycloak/themes/vp-cockpit/login/login-update-password.ftl -->
<#-- Step 2 of the reset flow, reached from the emailed link. Also the page a
     user lands on when an admin attaches the UPDATE_PASSWORD required action,
     which is the no-SMTP fallback path — so this template matters even in a
     stack that never sends mail. -->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('password','password-confirm'); section>
  <#if section = "form">
    <form id="kc-passwd-update-form" action="${url.loginAction}" method="post" class="vp-form" novalidate>
      <#-- Hidden, read-only, and deliberately present: password managers need a
           username field alongside the new-password fields to offer to save. -->
      <input type="text" id="username" name="username" value="${username}"
             autocomplete="username" readonly="readonly" style="display:none;" />

      <label class="vp-label" for="password-new">
        <span class="vp-label__text">New password</span>
        <input
          type="password"
          id="password-new"
          class="vp-input"
          name="password-new"
          autofocus
          autocomplete="new-password"
          aria-invalid="<#if messagesPerField.existsError('password','password-confirm')>true<#else>false</#if>"
        />
      </label>

      <label class="vp-label" for="password-confirm">
        <span class="vp-label__text">Confirm new password</span>
        <input
          type="password"
          id="password-confirm"
          class="vp-input"
          name="password-confirm"
          autocomplete="new-password"
          aria-invalid="<#if messagesPerField.existsError('password-confirm')>true<#else>false</#if>"
        />
      </label>

      <#if messagesPerField.existsError('password','password-confirm')>
        <div class="vp-field-error">
          ${kcSanitize(messagesPerField.getFirstError('password','password-confirm'))?no_esc}
        </div>
      </#if>

      <button class="vp-btn vp-btn--primary" type="submit">Set new password</button>

      <#if isAppInitiatedAction??>
        <button class="vp-btn vp-btn--secondary" type="submit" name="cancel-aia" value="true">Cancel</button>
      </#if>
    </form>
  </#if>
</@layout.registrationLayout>
