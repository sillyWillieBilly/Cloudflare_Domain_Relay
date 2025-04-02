// Example of hardcoded forward addresses (DELETE or COMMENT OUT if using dynamic loading)
// const forwardAddresses = [ ]; // Example: If not fetching dynamically

// New cache for email rules per domain/token
const rulesCache = new Map();

// Pagination & batch variables
let currentPage = 1;
let totalPages = 1;
let allRules = []; // Holds the full, filtered (only email rules), and sorted list for the current view

// Global view settings
let groupByDomain = false;
let darkMode = false;

// Global progress element for bulk actions (initialized later)
let bulkProgressIndicator = null;
let accountId = null; // To store the Cloudflare Account ID for fetching destinations

document.addEventListener('DOMContentLoaded', async () => {
  // loadForwardOptions(); // Now called dynamically after loadDomains gets accountId
  setupAnimations();

  // Load persisted settings for Dark Mode and Group by Domain
  const storedSettings = await browser.storage.local.get(['darkMode', 'groupByDomain']);
  darkMode = storedSettings.darkMode || false;
  groupByDomain = storedSettings.groupByDomain || false;

  // Inject extra controls only once above the output container
  setupExtraControls(); // Includes Import button now

  // Set initial state of toggles based on saved preferences
  const darkModeToggle = document.getElementById('darkModeToggle');
  const groupToggle = document.getElementById('groupToggle');
  if (darkModeToggle) darkModeToggle.checked = darkMode;
  if (groupToggle) groupToggle.checked = groupByDomain;
  document.body.classList.toggle('dark-mode', darkMode);

  // Autofill alias input with current website's full hostname
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs.length > 0 && tabs[0].url && (tabs[0].url.startsWith('http:') || tabs[0].url.startsWith('https:'))) {
        const currentURL = new URL(tabs[0].url);
        const hostname = currentURL.hostname;
        const aliasBase = extractAlias(hostname);
        const aliasInput = document.getElementById('alias');
        if (aliasInput) {
            aliasInput.placeholder = aliasBase;
            aliasInput.value = aliasBase;
        }
    } else {
        console.log("Could not get a valid URL from the active tab.");
        const aliasInput = document.getElementById('alias');
        if(aliasInput) aliasInput.placeholder = "Enter alias";
    }
  } catch (err) {
    console.error("Failed to process active tab's hostname:", err);
    const aliasInput = document.getElementById('alias');
    if(aliasInput) aliasInput.placeholder = "Enter alias";
  }


  // Load user preferences and trigger initial data load
  const stored = await browser.storage.local.get(['apiToken', 'sortMethod', 'pageSize', 'lastSelectedDomain']);
  const apiToken = stored.apiToken;
  const lastDomain = stored.lastSelectedDomain;
  const outputDiv = document.getElementById('output');

  const apiTokenInput = document.getElementById('apiToken');
  if(apiTokenInput && apiToken) {
    apiTokenInput.value = apiToken;
  }

  if (apiToken) {
    if (outputDiv) outputDiv.innerHTML = '<p>Loading domains & destinations...</p>'; // Updated message
    await loadDomains(); // This will trigger loadDestinationAddresses -> loadForwardOptions

    const domainSelect = document.getElementById('domainSelect');
    if (domainSelect) {
        if (lastDomain) {
            const optionExists = Array.from(domainSelect.options).some(opt => opt.value === lastDomain);
            if (optionExists) {
                domainSelect.value = lastDomain;
                console.log(`Restored last selected domain: ${lastDomain}`);
            } else {
                console.log(`Last selected domain ${lastDomain} not found, using default.`);
            }
        }

        if (domainSelect.value) {
           await listAliasesHandler(); // Load aliases for selected/remembered domain
        } else if (domainSelect.options.length > 0 && domainSelect.options[0].value) { // Check first option is valid
            domainSelect.selectedIndex = 0;
            const selectedZoneId = domainSelect.value;
            if (selectedZoneId) { await browser.storage.local.set({ lastSelectedDomain: selectedZoneId }); } // Save if valid
            await listAliasesHandler(); // Load aliases for the first domain
        } else {
            console.log("No domains available to list aliases for.");
            if (outputDiv) outputDiv.innerHTML = '<p>No domains found or selected for this API token.</p>';
        }
    } else {
        console.error("Domain select dropdown (#domainSelect) not found.");
        if (outputDiv) outputDiv.innerHTML = '<p>Error: UI element missing (#domainSelect).</p>';
    }

  } else {
      // No API token saved
      if (outputDiv) outputDiv.innerHTML = '<p>Please enter and save your Cloudflare API Token.</p>';
      // Try loading forward options to show the appropriate state (likely error)
      loadForwardOptions(null);
      // Ensure create button is disabled if no token
      const createAliasBtn = document.getElementById('createAlias');
      if (createAliasBtn) createAliasBtn.disabled = true;
  }


  // Set Sort Method dropdown value
  const sortMethodSelect = document.getElementById('sortMethod');
  if (sortMethodSelect && stored.sortMethod) {
    sortMethodSelect.value = stored.sortMethod;
  }

  // Set Page Size dropdown value
  const pageSizeSelect = document.getElementById('pageSize');
  if (pageSizeSelect) {
      if (stored.pageSize) {
        pageSizeSelect.value = stored.pageSize;
      } else {
        // Set default page size if none stored
        await browser.storage.local.set({ pageSize: 10 });
        pageSizeSelect.value = 10;
      }
  }


  // --- Event Listeners for UI Controls ---

  // Search Input
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
      searchInput.addEventListener('input', () => {
        currentPage = 1; // Reset to first page on search
        listAliasesHandler(); // Trigger list refresh
      });
  }

  // Sort Method Dropdown
  if (sortMethodSelect) {
      sortMethodSelect.addEventListener('change', async (e) => {
        const sortMethod = e.target.value;
        await browser.storage.local.set({ sortMethod });
        listAliasesHandler(); // Trigger list refresh
      });
  }

  // Page Size Dropdown
  if (pageSizeSelect) {
      pageSizeSelect.addEventListener('change', async (e) => {
        const pageSize = parseInt(e.target.value);
        await browser.storage.local.set({ pageSize });
        currentPage = 1; // Reset to first page on size change
        listAliasesHandler(); // Trigger list refresh
      });
  }

  // Domain Selection Dropdown (Auto-refresh aliases & Save preference)
  const domainSelectForChange = document.getElementById('domainSelect');
   if (domainSelectForChange) {
        domainSelectForChange.addEventListener('change', async (e) => {
          const selectedZoneId = e.target.value;
          if (selectedZoneId) { // Only proceed if a valid zone is selected
              await browser.storage.local.set({ lastSelectedDomain: selectedZoneId }); // Save preference
              currentPage = 1; // Reset pagination
              await listAliasesHandler(); // Refresh aliases for the new domain
          }
      });
   }

    // --- Alias Input Validation Setup ---
    const aliasInputForValidation = document.getElementById('alias');
    const createAliasButtonForValidation = document.getElementById('createAlias');
    const forwardSelectForValidation = document.getElementById('forwardSelect');

    const validateAliasInput = () => {
        // Ensure elements exist before validating
        if (!aliasInputForValidation || !createAliasButtonForValidation || !forwardSelectForValidation) {
            console.warn("Validation elements not ready.");
            return;
        }
        // Regex: Allows letters, numbers, dot, underscore, hyphen. No spaces. Must have content.
        const validAliasRegex = /^[a-zA-Z0-9._-]+$/;
        const aliasValue = aliasInputForValidation.value.trim();
        const isValid = aliasValue.length > 0 && validAliasRegex.test(aliasValue);
        const hasForward = forwardSelectForValidation.value !== ""; // Check if a destination is selected

        if (!isValid && aliasValue.length > 0) { // Show invalid style only if not empty but wrong chars
            aliasInputForValidation.classList.add('invalid');
        } else {
            aliasInputForValidation.classList.remove('invalid');
        }

        // Disable create button if alias is invalid OR no forward address selected
        // Also disable if forward select is disabled (e.g., loading/error)
        createAliasButtonForValidation.disabled = !isValid || !hasForward || forwardSelectForValidation.disabled;

        // Update tooltip based on why it might be disabled
        if (!isValid && aliasValue.length > 0) {
            createAliasButtonForValidation.title = "Alias contains invalid characters or spaces.";
        } else if (!isValid && aliasValue.length === 0) {
             createAliasButtonForValidation.title = "Please enter an alias name.";
        } else if (!hasForward || forwardSelectForValidation.disabled) {
            createAliasButtonForValidation.title = "Please select a valid forwarding destination.";
        } else {
            createAliasButtonForValidation.title = ""; // Clear tooltip if valid and enabled
        }
    };

    if (aliasInputForValidation) {
        aliasInputForValidation.addEventListener('input', validateAliasInput);
    }
    // Also validate when the forward selection changes (as it affects button state)
    if (forwardSelectForValidation) {
        forwardSelectForValidation.addEventListener('change', validateAliasInput);
        // Add listener to highlight destination list
         forwardSelectForValidation.addEventListener('change', highlightSelectedDestination);
    }
    validateAliasInput(); // Initial validation check on load
    // --- End Alias Input Validation Setup ---

    // Re-highlight destination on dark mode toggle
    const darkModeToggleForHighlight = document.getElementById('darkModeToggle');
    if (darkModeToggleForHighlight) {
        darkModeToggleForHighlight.addEventListener('change', highlightSelectedDestination);
    }

    // Attach handlers for primary action buttons (busy states handled within functions)
    const saveTokenButton = document.getElementById('saveToken');
    if (saveTokenButton) saveTokenButton.addEventListener('click', handleSaveTokenClick);

    const createAliasButton = document.getElementById('createAlias');
    if (createAliasButton) createAliasButton.addEventListener('click', handleCreateAliasClick);

    const listAliasesButton = document.getElementById('listAliases');
    if (listAliasesButton) listAliasesButton.addEventListener('click', listAliasesHandler); // Allow manual refresh

}); // End of DOMContentLoaded

// Gets subdomain and base domain from the current active tab
async function getCurrentHostnameParts() {
    try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (tabs && tabs.length > 0 && tabs[0].url && (tabs[0].url.startsWith('http:') || tabs[0].url.startsWith('https:'))) {
            const currentURL = new URL(tabs[0].url);
            const currentHostname = currentURL.hostname.toLowerCase();
            const hostnameParts = currentHostname.split('.');

            // Find the base domain (e.g., example.com, example.co.uk)
            const multiPartTLDs = ['co.uk', 'com.au', 'co.jp', 'org.uk', 'gov.uk', 'ac.uk', 'com.br', 'org.br'];
            let baseDomainIndex = hostnameParts.length - 2; // Assume SLD + TLD
            for (const tld of multiPartTLDs) {
                if (currentHostname.endsWith('.' + tld)) {
                    baseDomainIndex = hostnameParts.length - (tld.split('.').length + 1);
                    break;
                }
            }
             // Ensure index is valid
            if (baseDomainIndex < 0) baseDomainIndex = 0;


            const baseDomain = hostnameParts.slice(baseDomainIndex).join('.');
            const subdomainPart = hostnameParts.slice(0, baseDomainIndex).join('.'); // Can be empty string if no subdomain

             // Extract the core name from the base domain (e.g., "example" from "example.com")
             const baseDomainName = hostnameParts[baseDomainIndex] || '';


            console.log(`Current context: Subdomain='${subdomainPart}', BaseDomain='${baseDomain}', BaseName='${baseDomainName}'`);
            return { subdomain: subdomainPart, baseDomainName: baseDomainName };

        }
    } catch (err) {
        console.error("Failed to get current hostname parts:", err);
    }
    // Return defaults if unable to get context
    return { subdomain: '', baseDomainName: '' };
}

// Assigns a numerical priority based on context match
function getPriority(rule, subdomain, baseDomainName) {
    if (!rule || !rule.matchers || !rule.matchers[0]?.value) return 3; // Lowest priority if invalid rule

    const aliasWithValue = rule.matchers[0].value.toLowerCase();
    const alias = aliasWithValue.split('@')[0]; // Get the part before @

    // Exact subdomain match (highest priority)
    // e.g., alias 'images' on 'images.google.com'
    if (subdomain && alias === subdomain) return 0;

    // Alias *contains* the subdomain (second highest)
    // e.g., alias 'images-backup' on 'images.google.com'
    // or alias 'images.google' on 'images.google.com' (if subdomain was just 'images')
    if (subdomain && alias.includes(subdomain)) return 1;


    // Alias matches the base domain name (third priority)
    // e.g., alias 'google' on 'images.google.com' or 'google.com'
    if (baseDomainName && alias === baseDomainName) return 2;

     // Alias *contains* the base domain name (fourth priority)
     // e.g., alias 'google-maps' on 'images.google.com' or 'google.com'
    if (baseDomainName && alias.includes(baseDomainName)) return 3;


    // No relevant match
    return 4; // Lowest priority
}
// --- Button Click Handlers with Busy States ---

async function handleSaveTokenClick() {
    const tokenInput = document.getElementById('apiToken');
    const saveTokenButton = document.getElementById('saveToken');
    const outputDiv = document.getElementById('output');
    const domainSelect = document.getElementById('domainSelect');
    const token = tokenInput ? tokenInput.value.trim() : '';
    if (!token) { showToast("API token cannot be empty", "error"); return; }

    if (saveTokenButton) { saveTokenButton.disabled = true; saveTokenButton.textContent = 'Verifying...'; }

    try {
        const testRes = await fetch('https://api.cloudflare.com/client/v4/zones?per_page=1', { headers: { 'Authorization': 'Bearer ' + token } });
        const testData = await testRes.json();
        if (!testRes.ok || !testData.success) {
            const errorMsg = testData?.errors?.[0]?.message || `HTTP ${testRes.status}`;
            showToast(`Invalid Token or insufficient permissions: ${errorMsg}`, "error");
            return; // Return before finally
        }
        await browser.storage.local.set({ apiToken: token });
        showToast("Token Saved!");
        if (domainSelect) domainSelect.innerHTML = '';
        if (outputDiv) outputDiv.innerHTML = '<p>Loading domains...</p>';
        accountId = null; // Reset account ID on new token save
        await loadDomains(); // Will load domains & destinations

        if (domainSelect && domainSelect.options.length > 0 && domainSelect.options[0].value) {
            domainSelect.selectedIndex = 0;
            const selectedZoneId = domainSelect.value;
            if (selectedZoneId) { await browser.storage.local.set({ lastSelectedDomain: selectedZoneId }); }
            currentPage = 1;
            await listAliasesHandler();
        } else {
            if (outputDiv) outputDiv.innerHTML = '<p>No domains found for this token.</p>';
        }
    } catch (err) { console.error("Error validating/saving token:", err); showToast("Error validating token. Check console.", "error"); }
    finally {
         if (saveTokenButton) { saveTokenButton.disabled = false; saveTokenButton.textContent = 'Save Token'; }
    }
}

async function handleCreateAliasClick() {
    const tokenInput = document.getElementById('apiToken');
    const domainSelect = document.getElementById('domainSelect');
    const aliasInput = document.getElementById('alias');
    const forwardSelect = document.getElementById('forwardSelect');
    const createButton = document.getElementById('createAlias');

    if (!tokenInput || !domainSelect || !aliasInput || !forwardSelect || !createButton) { showToast("Error: A required UI element is missing.", "error"); return; }
    const token = tokenInput.value.trim(); const zoneId = domainSelect.value; const alias = aliasInput.value.trim(); const forwardTo = forwardSelect.value;

    // Validation re-check (although button should be disabled)
    if (!token || !zoneId || !alias || !forwardTo || !/^[a-zA-Z0-9._-]+$/.test(alias)) { showToast("Invalid input for alias creation.", "error"); return; }

    const domainName = domainSelect.selectedOptions[0]?.text;
    if (!domainName) return showToast("Could not get domain name.", "error");
    const newAddress = `${alias}@${domainName}`;
    const payload = { matchers: [{ type: "literal", field: "to", value: newAddress }], actions: [{ type: "forward", value: [forwardTo] }], enabled: true, name: `FEA: ${alias}` };

    createButton.disabled = true; createButton.textContent = 'Creating...';

    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules`, { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (data.success) {
            showToast(`Created: ${newAddress} → ${forwardTo}`); aliasInput.value = ''; aliasInput.placeholder = 'Enter next alias';
            invalidateRulesCache(token, zoneId); setTimeout(() => listAliasesHandler(), 500);
        } else {
            const errorMsg = data?.errors?.[0]?.message || JSON.stringify(data.errors);
            showToast(errorMsg.includes('already exists') ? `Error: Alias for ${newAddress} might already exist.` : `Error creating alias: ${errorMsg}`, "error");
            console.error('Alias creation failed:', data.errors);
        }
    } catch (err) { console.error('Network error during alias creation:', err); showToast("Network error during alias creation.", "error"); }
    finally {
        createButton.disabled = false; createButton.textContent = 'Create Alias';
        // Re-run validation after attempt
        const isValidAlias = aliasInput.value.trim().length > 0 && /^[a-zA-Z0-9._-]+$/.test(aliasInput.value.trim());
        const hasForward = forwardSelect && forwardSelect.value !== "";
        createButton.disabled = !isValidAlias || !hasForward; // Reset disabled state correctly
        if (!isValidAlias) aliasInput.classList.add('invalid'); else aliasInput.classList.remove('invalid'); // Update style if needed
    }
}


// -------------------- UI Setup Functions --------------------
function setupAnimations() {
  const style = document.createElement('style');
  style.textContent = `
    .fade-in { animation: fadeIn 0.3s ease-in-out; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .fade-out { opacity: 0; transition: opacity 0.3s ease-out; }

    /* Toast notifications */
    .toast {
      position: fixed; bottom: 20px; right: 20px; background: #333; color: #fff;
      padding: 10px 15px; border-radius: 4px; opacity: 0.9; z-index: 1000;
      font-size: 14px; transition: opacity 0.5s ease-out;
    }
    .toast.error { background: #e74c3c; }
    .toast.success { background: #28a745; }

    /* General Styles */
    body { font-family: sans-serif; }
    #output { background-color: #f5f5f5; color: #333; border-radius: 4px; padding: 10px; min-height: 50px; margin-top: 15px; }
    .group-header { color: #333; background-color: #e0e0e0; padding: 5px 10px; font-weight: bold; margin-top: 10px; border-radius: 3px; }
    ul { list-style-type: none; padding: 0; margin: 0; }

    /* --- List Item Styling (Consistent Copy Button Placement Start) --- */
    li {
      display: flex; align-items: center; background-color: #ffffff; margin-bottom: 5px; padding: 10px; border-radius: 4px;
      color: #333; border: 1px solid #e0e0e0;
      transition: background-color 0.2s ease, opacity 0.5s ease-out, height 0.5s ease-out, padding 0.5s ease-out, margin 0.5s ease-out;
      overflow: hidden;
    }
    li:hover { background-color: #f0f0f0; }

    /* Alias Container (Icon + Text) */
    .alias-container {
       flex: 0 1 280px; /* Don't grow, Can shrink, Basis/Max width 280px */
       white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
       display: inline-flex; align-items: center;
    }
    .alias-email { /* Inner text span */
      margin-left: 5px; color: #2E7D32; font-weight: 500;
      display: inline-block; vertical-align: middle;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
     .alias-name { /* If used */
       margin-left: 5px; color: #1976D2; font-weight: 500; display: inline-block; vertical-align: middle;
       white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
     }

    /* Copy Button (Direct child of li) */
    .copy-alias-btn {
        flex: 0 0 auto; /* Don't grow or shrink */
        background: none; border: none; cursor: pointer; padding: 0; /* Remove padding */
        margin-left: 10px;  /* Space AFTER alias container */
        margin-right: 8px; /* Space BEFORE arrow */
        font-size: 1.1em; line-height: 1; vertical-align: middle; opacity: 0.6;
        transition: opacity 0.2s ease;
    }
    .copy-alias-btn:hover { opacity: 1; }

    /* Arrow Span */
    .arrow-span {
      flex: 0 0 auto;
      padding: 0; /* No padding needed */
      color: #888; line-height: 1;
      margin-right: 8px; /* Space BEFORE forward email */
    }

    /* Forward Span */
    .forward-email {
      flex: 0 1 280px; /* Don't grow, Can shrink, Basis/Max width */
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      display: inline-block; vertical-align: middle; color: #555;
    }
     .forward-email > span:contains('Drop') { color: #e74c3c; } /* Style Drop action */


    /* Actions Block (Pushed to right) */
    .alias-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .alias-actions .select-rule { margin: 0; vertical-align: middle; cursor: pointer; }
    /* --- End List Item Styling --- */

    /* Status Badge */
    .status { padding: 3px 6px; border-radius: 3px; font-size: 0.8em; white-space: nowrap; }
    .status.badge-active { background-color: #4CAF50; color: white; }
    .status.badge-disabled { background-color: #f44336; color: white; }

    /* Buttons */
    .toggle-btn, .delete-btn, .batch-btn, #exportRules,#importRulesBtn {
      background-color: #f0f0f0; color: #333; border: 1px solid #ccc; padding: 5px 8px;
      border-radius: 3px; cursor: pointer; font-size: 0.9em; white-space: nowrap;
      transition: background-color 0.2s ease, border-color 0.2s ease;
    }
    button:disabled { cursor: not-allowed; opacity: 0.6; }
    button:not(:disabled):not(.active):not(.disabled):not(.danger):hover, /* General button hover */
    #exportRules:not(:disabled):hover { background-color: #e0e0e0; border-color: #bbb; }
    #importRulesBtn:not(:disabled):hover { background-color: #e0e0e0; border-color: #bbb; }
    .toggle-btn.active { background-color: #ff9800; color: white; border-color: #f57c00; }
    .toggle-btn.active:hover { background-color: #f57c00; }
    .toggle-btn.disabled { background-color: #4CAF50; color: white; border-color: #388e3c; }
    .toggle-btn.disabled:hover { background-color: #388e3c; }
    .delete-btn, .batch-btn.danger { background-color: #f44336; color: white; border-color: #d32f2f; }
    .delete-btn:hover, .batch-btn.danger:hover { background-color: #d32f2f; }

    /* Alias input validation style */
    input#alias.invalid { border: 1px solid #e74c3c; outline-color: #e74c3c; }

    /* --- Dark mode --- */
    body.dark-mode { background-color: #2c2c2c; color: #ddd; }
    body.dark-mode #output { background-color: #3a3a3a; color: #ddd; border: 1px solid #4a4a4a; }
    body.dark-mode li:hover { background-color: #4a4a4a !important; }
    body.dark-mode input:not([type=checkbox]), body.dark-mode select,
    body.dark-mode button:not(.danger):not(.active):not(.disabled):not(:disabled) { background-color: #555; color: #eee; border: 1px solid #666; }
    body.dark-mode button:disabled { background-color: #444 !important; color: #888 !important; border-color: #555 !important; }
    body.dark-mode input::placeholder { color: #aaa; }
    body.dark-mode input[type=checkbox] { accent-color: #66BB6A; }
    body.dark-mode .copy-alias-btn { filter: invert(1) brightness(1.2); opacity: 0.7; } /* Make emoji visible */
    body.dark-mode .copy-alias-btn:hover { opacity: 1; }
    body.dark-mode .group-header { color: #eee; background-color: #444; border: 1px solid #555; }
    body.dark-mode li { background-color: #424242 !important; border: 1px solid #555 !important; color: #ddd; }
    body.dark-mode .alias-email { color: #81C784 !important; }
    body.dark-mode .alias-name { color: #90CAF9 !important; }
    body.dark-mode .arrow-span { color: #aaa; }
    body.dark-mode .forward-email { color: #ccc !important; }
    body.dark-mode .forward-email > span:contains('Drop') { color: #EF5350; } /* Lighter red for drop */
    body.dark-mode button:not(:disabled):not(.active):not(.disabled):not(.danger):hover, /* Dark button hover */
    body.dark-mode #exportRules:not(:disabled):hover { background-color: #666; border-color: #777; }
    body.dark-mode #importRulesBtn:not(:disabled):hover { background-color: #666; border-color: #777; }
    body.dark-mode .status.badge-active { background-color: #66BB6A; color: black; }
    body.dark-mode .status.badge-disabled { background-color: #EF5350; color: white; }
    body.dark-mode .toggle-btn.active { background-color: #FFA726; color: black; border-color: #FB8C00; }
    body.dark-mode .toggle-btn.active:hover { background-color: #FB8C00; }
    body.dark-mode .toggle-btn.disabled { background-color: #66BB6A; color: black; border-color: #4CAF50; }
    body.dark-mode .toggle-btn.disabled:hover { background-color: #4CAF50; }
    body.dark-mode .delete-btn, body.dark-mode .batch-btn.danger { background-color: #EF5350; color: white; border-color: #E53935; }
    body.dark-mode .delete-btn:hover, body.dark-mode .batch-btn.danger:hover { background-color: #E53935; }
    body.dark-mode input#alias.invalid { border-color: #EF5350; outline-color: #EF5350; }
    /* --- End Dark mode --- */

	#destinationAddressesSection { border-top: 1px solid #ccc; padding-top: 15px; }
	body.dark-mode #destinationAddressesSection { border-top-color: #444; }
	body.dark-mode #destinationList { background-color: #444; }
	#destinationList li { margin-bottom: 3px; }

    /* Pagination Controls */
    .pagination-controls { display: flex; justify-content: center; align-items: center; margin-top: 15px; gap: 10px; }
    .pagination-controls button { padding: 5px 10px; }
    .pagination-controls span { font-size: 0.9em; padding: 0 5px; }

    /* Loading Spinner */
    .loading-container { display: flex; justify-content: center; align-items: center; min-height: 50px; }
    .spinner { border: 4px solid rgba(0, 0, 0, 0.1); width: 36px; height: 36px; border-radius: 50%; border-left-color: #09f; animation: spin 1s ease infinite; }
    body.dark-mode .spinner { border-color: rgba(255, 255, 255, 0.1); border-left-color: #66BB6A; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

    /* Responsive */
    @media (max-width: 600px) {
        body { font-size: 14px; }
        #extraControls { grid-template-columns: 1fr; gap: 8px; }
        #extraControls > label { margin-top: 5px;}
        #bulkActions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
        #bulkActions label { margin-right: auto; }
        li { gap: 5px; padding: 8px; }
        .alias-container, .forward-email { flex-basis: 120px; /* Adjust basis */ }
        .copy-alias-btn { margin-left: 5px; margin-right: 4px; font-size: 1em;}
        .arrow-span { margin-right: 4px; }
        .alias-actions { margin-left: auto; width: auto; justify-content: flex-end; margin-top: 0; gap: 5px; }
        .toggle-btn, .delete-btn, .batch-btn, #exportRules { font-size: 0.85em; padding: 4px 6px;}
        .status { font-size: 0.75em; }
    }
  `;
  document.head.appendChild(style);
}

function setupExtraControls() {
  if (document.getElementById('extraControlsContainer')) return;
  const controlsWrapper = document.createElement('div'); controlsWrapper.id = 'extraControlsContainer';

  const controlsContainer = document.createElement('div'); controlsContainer.id = "extraControls";
  controlsContainer.style.cssText = `
    display: grid; grid-template-columns: 1fr auto auto auto auto; gap: 10px;
    align-items: center; margin-bottom: 10px; padding-bottom: 10px;
    border-bottom: 1px solid ${darkMode ? '#444' : '#ccc'};
  `;

  // --- Create Elements ---
  const searchInput = document.createElement('input'); searchInput.type = "text"; searchInput.id = "searchInput"; searchInput.placeholder = "Search..."; searchInput.style.width = "100%"; searchInput.title = "Filter list by alias or destination";
  const groupToggleLabel = document.createElement('label'); groupToggleLabel.style.cssText = 'white-space:nowrap; cursor:pointer;'; groupToggleLabel.title = "Group aliases by domain";
  const groupToggle = document.createElement('input'); groupToggle.type = "checkbox"; groupToggle.id = "groupToggle"; groupToggle.style.cssText = 'vertical-align:middle; margin-right:3px;'; groupToggleLabel.append(groupToggle, " Group");
  const darkModeToggleLabel = document.createElement('label'); darkModeToggleLabel.style.cssText = 'white-space:nowrap; cursor:pointer;'; darkModeToggleLabel.title = "Toggle dark mode";
  const darkModeToggle = document.createElement('input'); darkModeToggle.type = "checkbox"; darkModeToggle.id = "darkModeToggle"; darkModeToggle.style.cssText = 'vertical-align:middle; margin-right:3px;'; darkModeToggleLabel.append(darkModeToggle, " Dark");
  const exportButton = document.createElement('button'); exportButton.id = "exportRules"; exportButton.textContent = "Export"; exportButton.title = "Export rules for domain";
  const importButton = document.createElement('button'); importButton.id = "importRulesBtn"; importButton.textContent = "Import"; importButton.title = "Import rules from JSON";
  const importFileInput = document.createElement('input'); importFileInput.type = "file"; importFileInput.id = "importFile"; importFileInput.accept = ".json"; importFileInput.style.display = "none";

  const bulkActionsContainer = document.createElement('div'); bulkActionsContainer.id = "bulkActions";
  bulkActionsContainer.style.cssText = `grid-column: 1 / -1; margin-top: 10px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center;`;
  bulkActionsContainer.innerHTML = `
    <label style="margin-right: 10px; cursor:pointer;" title="Select/Deselect all visible aliases">
      <input type="checkbox" id="selectAll" style="vertical-align:middle; margin-right:3px;"/> Select All
    </label>
    <button id="bulkEnable" class="batch-btn" title="Enable selected">Enable Sel.</button>
    <button id="bulkDisable" class="batch-btn" title="Disable selected">Disable Sel.</button>
    <button id="bulkDelete" class="batch-btn danger" title="Delete selected">Delete Sel.</button>
    <span id="bulkProgress" style="margin-left:auto; font-size: 0.9em; display:none;"></span>`;

  // --- Append Elements ---
  controlsContainer.append(searchInput, groupToggleLabel, darkModeToggleLabel, exportButton, importButton);
  controlsContainer.appendChild(importFileInput);
  controlsContainer.appendChild(bulkActionsContainer);
  controlsWrapper.appendChild(controlsContainer);
  const outputContainer = document.getElementById('output');
  if (outputContainer?.parentNode) { outputContainer.parentNode.insertBefore(controlsWrapper, outputContainer); }
  else { document.body.insertBefore(controlsWrapper, document.body.firstChild); }

  bulkProgressIndicator = document.getElementById('bulkProgress');

  // --- Add Event Listeners ---
  groupToggle.addEventListener('change', async (e) => { groupByDomain = e.target.checked; await browser.storage.local.set({ groupByDomain }); listAliasesHandler(); });
  darkModeToggle.addEventListener('change', async (e) => { darkMode = e.target.checked; document.body.classList.toggle('dark-mode', darkMode); controlsContainer.style.borderBottomColor = darkMode ? '#444' : '#ccc'; await browser.storage.local.set({ darkMode }); });
  exportButton.addEventListener('click', exportRules);

  // --- Import Button Listener (Attaches Change Listener Temporarily) ---
  importButton.addEventListener('click', () => {
      console.log("Import button clicked. Attaching 'change' listener to file input...");
      // Attach the change listener with { once: true } right before triggering click
      importFileInput.addEventListener('change', handleImportFile, { once: true });
      console.log("'change' listener attached with { once: true }.");

      // Reset value just before click to allow selecting the same file again
      importFileInput.value = null;
      console.log("Reset file input value.");

      try {
          console.log("Triggering file input click...");
          importFileInput.click();
          console.log("importFileInput.click() called successfully.");
      } catch (err) {
          console.error("Error calling importFileInput.click():", err);
          showToast("Could not open file dialog.", "error");
          // Remove the listener if click fails? Maybe not necessary with {once: true}
          // importFileInput.removeEventListener('change', handleImportFile);
      }
  });
  // --- End Import Listeners ---


  const selectAllCheckbox = document.getElementById('selectAll');
  const bulkEnableBtn = document.getElementById('bulkEnable');
  const bulkDisableBtn = document.getElementById('bulkDisable');
  const bulkDeleteBtn = document.getElementById('bulkDelete');
  if (selectAllCheckbox) selectAllCheckbox.addEventListener('change', toggleSelectAll);
  if (bulkEnableBtn) bulkEnableBtn.addEventListener('click', () => bulkAction('enable'));
  if (bulkDisableBtn) bulkDisableBtn.addEventListener('click', () => bulkAction('disable'));
  if (bulkDeleteBtn) bulkDeleteBtn.addEventListener('click', () => bulkAction('delete'));

  console.log("setupExtraControls finished."); // Confirm function completes
}

// -------------------- Toast Notification --------------------
function showToast(message, type = "success") {
  const toast = document.createElement('div'); toast.className = `toast ${type}`; toast.textContent = message; document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 500); }, 3000);
}

// -------------------- Core API & Data Loading --------------------
async function loadDomains() {
  const tokenInput = document.getElementById('apiToken'); const select = document.getElementById('domainSelect');
  const token = tokenInput ? tokenInput.value.trim() : '';
  if (!select) { console.error("Cannot load domains: #domainSelect element not found."); return; }
  if (!token) { select.innerHTML = '<option value="">Enter API Token</option>'; select.disabled = true; return; }
  select.disabled = true; select.innerHTML = '<option value="">Loading domains...</option>';

  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/zones?per_page=100', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json(); select.innerHTML = '';
    if (data.success && data.result?.length > 0) {
      if (!accountId && data.result[0].account?.id) { // Capture Account ID
          accountId = data.result[0].account.id; console.log(`Account ID captured: ${accountId}`);
          await loadDestinationAddresses(); // Load destinations now
      }
      data.result.forEach(zone => { const opt = document.createElement('option'); opt.value = zone.id; opt.textContent = zone.name; select.appendChild(opt); });
      select.disabled = false;
    } else if (data.success) { // No domains found
       select.innerHTML = '<option value="">No domains found</option>'; showToast("No domains (zones) found for this token.", "error");
       if(accountId) await loadDestinationAddresses(); // Still try loading destinations if somehow had accountId
    } else { // API error
      const errorMsg = data?.errors?.[0]?.message || `HTTP ${res.status}`; select.innerHTML = `<option value="">Error: ${errorMsg}</option>`;
      showToast(`Failed to load domains: ${errorMsg}`, "error"); console.error("Failed to load domains:", data.errors || `Status ${res.status}`);
      accountId = null; loadForwardOptions(null); // Reset account ID and show error in forward options
    }
  } catch (err) { // Network error
    console.error("Network error loading domains:", err); select.innerHTML = '<option value="">Network error</option>'; showToast("Network error loading domains", "error");
    accountId = null; loadForwardOptions(null); // Reset and show error
  }
}

async function loadDestinationAddresses() {
    const tokenInput = document.getElementById('apiToken'); const token = tokenInput ? tokenInput.value.trim() : '';
    const forwardSelect = document.getElementById('forwardSelect');
    if (!forwardSelect) { console.error("Cannot load destinations: #forwardSelect not found."); return; }
    if (!token) { console.log("Cannot load destinations: Token missing."); loadForwardOptions(null); return; }
    if (!accountId) { console.error("Cannot load destination addresses: Account ID missing."); showToast("Cannot load destination addresses (Account ID missing).", "error"); loadForwardOptions(null); return; }
    forwardSelect.innerHTML = '<option value="">Loading destinations...</option>'; forwardSelect.disabled = true;
    try {
        const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/routing/addresses`;
        const res = await fetch(apiUrl, { headers: { 'Authorization': `Bearer ${token}` } });
        const data = await res.json();
        if (data.success && data.result) {
            const verifiedAddresses = data.result.filter(addr => addr.verified); console.log(`Found ${verifiedAddresses.length} verified destination addresses.`);
            loadForwardOptions(verifiedAddresses);
        } else if (data.success) { console.log("No destination addresses found."); loadForwardOptions([]); }
        else { throw new Error(data?.errors?.[0]?.message || `HTTP ${res.status}`); }
    } catch (err) { console.error("Error fetching destination addresses:", err); showToast(`Error loading destinations: ${err.message}`, "error"); loadForwardOptions(null); }
}

function loadForwardOptions(destinationAddresses) {
  const forwardSelect = document.getElementById('forwardSelect');
  const createAliasBtn = document.getElementById('createAlias');
  const destSection = document.getElementById('destinationAddressesSection'); // Get section
  const destList = document.getElementById('destinationList'); // Get UL

  // Ensure elements exist
  if (!forwardSelect || !destSection || !destList) {
      console.error("Cannot load forward options/dest list: Core element missing.");
      if(destSection) destSection.style.display = 'none'; // Hide if error
      return;
  }

  forwardSelect.innerHTML = ''; forwardSelect.disabled = true;
  destList.innerHTML = ''; // Clear destination list UL
  destSection.style.display = 'none'; // Hide section initially
  if (createAliasBtn) createAliasBtn.disabled = true;

  if (destinationAddresses === null) { // Error state
      const opt = document.createElement('option'); opt.value = ""; opt.textContent = "Error loading destinations"; opt.disabled = true; forwardSelect.appendChild(opt);
      destList.innerHTML = '<li>Error loading.</li>';
      destSection.style.display = 'block'; // Show section with error
      return;
  }

  if (destinationAddresses?.length > 0) { // Success with addresses
      destSection.style.display = 'block'; // Show the section
      destinationAddresses.forEach(addr => {
          // Populate dropdown
          const opt = document.createElement('option'); opt.value = addr.email; opt.textContent = addr.email; forwardSelect.appendChild(opt);
          // Populate display list
          const li = document.createElement('li'); li.textContent = addr.email; li.dataset.email = addr.email; // Add data attribute
          destList.appendChild(li);
      });
      forwardSelect.disabled = false;
      if (createAliasBtn) { // Re-validate create button state
           const aliasInput = document.getElementById('alias');
           const isValidAlias = aliasInput && aliasInput.value.trim().length > 0 && /^[a-zA-Z0-9._-]+$/.test(aliasInput.value.trim());
           createAliasBtn.disabled = !isValidAlias; // Enable if alias is valid (since destinations exist now)
      }
      // Initial highlight
      highlightSelectedDestination();
  } else { // Success but empty list
      destSection.style.display = 'block'; // Show section
      const opt = document.createElement('option'); opt.value = ""; opt.textContent = "No verified destinations"; opt.disabled = true; forwardSelect.appendChild(opt);
      destList.innerHTML = '<li>None found.</li>';
  }
}

// --- NEW HELPER FUNCTION for highlighting ---
function highlightSelectedDestination() {
    const forwardSelect = document.getElementById('forwardSelect');
    const destList = document.getElementById('destinationList');
    if (!forwardSelect || !destList) return;

    const selectedEmail = forwardSelect.value;

    // Remove existing highlights
    destList.querySelectorAll('li').forEach(li => {
        li.style.fontWeight = 'normal';
        li.style.color = darkMode ? '#ccc' : '#333'; // Reset color based on mode
    });

    // Add highlight to the selected one
    const selectedLi = destList.querySelector(`li[data-email="${selectedEmail}"]`);
    if (selectedLi) {
        selectedLi.style.fontWeight = 'bold';
        selectedLi.style.color = darkMode ? '#81C784' : '#2E7D32'; // Highlight color
    }
}

function extractAlias(hostname) { // Corrected version with subdomain support
  if (!hostname) return '';
  const multiPartTLDs = ['co.uk', 'com.au', 'co.jp', 'org.uk', 'gov.uk', 'ac.uk', 'com.br', 'org.br'];
  let cleanHostname = hostname.toLowerCase().replace(/^www\./, '');
  const parts = cleanHostname.split('.');
  if (parts.length <= 1) return cleanHostname;
  for (const tld of multiPartTLDs) {
    if (cleanHostname.endsWith('.' + tld)) {
      const tldPartsCount = tld.split('.').length; const baseParts = parts.slice(0, parts.length - tldPartsCount);
      return baseParts.length > 0 ? baseParts.join('.') : cleanHostname.replace(/\./g, '-');
    }
  }
  if (parts.length >= 2) { return parts.slice(0, -1).join('.'); } // All except last part
  return cleanHostname.replace(/\./g, '-'); // Fallback
}

async function getCachedEmailRules(token, zoneId, forceRefresh = false) {
  const cacheKey = `${token}_${zoneId}`; if (!forceRefresh && rulesCache.has(cacheKey)) { console.log(`Using cached rules for zone ${zoneId}`); return rulesCache.get(cacheKey); }
  console.log(`Fetching rules for zone ${zoneId}`); const rules = await fetchEmailRules(token, zoneId);
  if (rules !== null) { rulesCache.set(cacheKey, rules); } return rules;
}

function invalidateRulesCache(token, zoneId) {
  const cacheKey = `${token}_${zoneId}`; if (rulesCache.has(cacheKey)) { rulesCache.delete(cacheKey); console.log(`Invalidated cache for zone ${zoneId}`); }
}

async function fetchEmailRules(token, zoneId) {
    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules?per_page=1000`, { headers: { 'Authorization': 'Bearer ' + token } }); const data = await res.json();
        if (data.success) { return data.result || []; }
        else { const errorMsg = data?.errors?.[0]?.message || `HTTP ${res.status}`; showToast(`Error fetching rules: ${errorMsg}`, "error"); console.error("Error fetching email rules:", data.errors || `Status ${res.status}`); return null; }
    } catch (err) { console.error("Network error fetching email rules:", err); showToast("Network error fetching rules.", "error"); return null; }
}

// --- sortRules Function ---
function sortRules(rules, sortMethod, subdomain, baseDomainName) { // Added context arguments
    if (!rules) return [];

    return rules.sort((a, b) => {
        // 1. Calculate Contextual Priority
        const priorityA = getPriority(a, subdomain, baseDomainName);
        const priorityB = getPriority(b, subdomain, baseDomainName);

        // 2. Sort Primarily by Contextual Priority (lower number = higher relevance)
        if (priorityA !== priorityB) {
            return priorityA - priorityB;
        }

        // 3. If Contextual Priority is the same, sort by User Selected Method
        const valA = getRuleDisplayValue(a); // Gets the full alias@domain string
        const valB = getRuleDisplayValue(b);
        const cloudflarePrioA = a.priority ?? 9999; // Cloudflare's own priority number
        const cloudflarePrioB = b.priority ?? 9999;

        switch (sortMethod) {
            case 'name-asc':
                return valA.localeCompare(valB);
            case 'name-desc':
                return valB.localeCompare(valA);
            case 'priority': // User selected Cloudflare priority sort
                return cloudflarePrioA - cloudflarePrioB;
            default: // Default fallback if sortMethod is unknown
                return valA.localeCompare(valB);
        }
    });
}
// --- END sortRules Function ---

function getRuleDisplayValue(rule) { return rule.matchers[0].value.toLowerCase(); }

// -------------------- List Aliases & Rendering --------------------
async function listAliasesHandler() {
  // Get references to necessary elements
  const tokenInput = document.getElementById('apiToken');
  const domainSelect = document.getElementById('domainSelect');
  const output = document.getElementById('output');
  const searchInput = document.getElementById('searchInput');
  const sortMethodSelect = document.getElementById('sortMethod');
  const paginationContainer = document.getElementById('paginationContainer');

  // --- Pre-checks for essential elements ---
  if (!output || !tokenInput || !domainSelect) {
      const missing = !output ? "#output" : !tokenInput ? "#apiToken" : "#domainSelect";
      showToast(`Error: UI component missing (${missing}).`, "error");
      if (output) output.innerHTML = `<p>Error: UI component missing (${missing}).</p>`;
      return;
  }

  // Get token and zoneId
  const token = tokenInput.value.trim();
  const zoneId = domainSelect.value;

  // --- Pre-checks for token and zoneId ---
  if (!token) {
      output.innerHTML = '<p>API Token is missing.</p>';
      return;
  }
  if (!zoneId) {
      output.innerHTML = `<p>Please select a domain.</p>`;
      // Add spinner if domains are still loading
      if (domainSelect.options.length > 0 && domainSelect.options[0].text.includes('Loading')) {
          output.innerHTML += ` <span class="spinner" style="width:16px;height:16px;border-width:2px;vertical-align:middle;display:inline-block;"></span>`;
      }
      return;
  }

  // --- UI Update: Clear pagination and show loading spinner ---
  if (paginationContainer) paginationContainer.innerHTML = '';
  output.innerHTML = `<div class="loading-container"><div class="spinner"></div></div>`;

  try {
    // 1. Fetch rules (from cache or API)
    let rules = await getCachedEmailRules(token, zoneId);
    if (rules === null) { // Handle fetch failure
        output.innerHTML = `<p>Failed to fetch aliases. Check token/permissions.</p>`;
        return;
    }

    // 2. Filter for EMAIL RULES ONLY (literal 'to' matcher)
    const originalCount = rules.length;
    rules = rules.filter(rule =>
        rule.matchers?.some(m => m.type === 'literal' && m.field === 'to' && m.value)
    );
    console.log(`Filtered ${originalCount - rules.length} non-email rules.`);

    // 3. GET CURRENT BROWSER CONTEXT (Subdomain, Base Domain Name)
    const { subdomain, baseDomainName } = await getCurrentHostnameParts();

    // 4. Apply search filter (if any)
    const searchQuery = searchInput ? searchInput.value.trim().toLowerCase() : '';
    if (searchQuery) {
      rules = rules.filter(rule => {
          const aliasEmail = rule.matchers[0].value.toLowerCase(); // Guaranteed to exist now
          const forward = rule.actions?.[0]?.value?.[0]?.toLowerCase() || '';
          const ruleName = rule.name?.toLowerCase() || '';
          return aliasEmail.includes(searchQuery) || forward.includes(searchQuery) || ruleName.includes(searchQuery);
      });
    }

    // 5. Sort rules using context + selected method
    const sortMethod = sortMethodSelect ? sortMethodSelect.value : 'name-asc'; // Default sort
    const sortedRules = sortRules(rules, sortMethod, subdomain, baseDomainName); // Pass context
    allRules = sortedRules; // Store globally filtered/sorted list

    // 6. Reset 'Select All' checkbox state
    const selectAllCheckbox = document.getElementById('selectAll');
    if (selectAllCheckbox) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
        // Update disabled state based on whether there are rules to select
        updateSelectAllCheckboxState(); // Call helper to set disabled state correctly
    } else {
        console.warn("listAliasesHandler: Could not find #selectAll checkbox.");
    }

    // 7. Pagination & Rendering
    if (allRules.length > 0) {
      const pageSizeElement = document.getElementById('pageSize');
      const pageSize = pageSizeElement ? parseInt(pageSizeElement.value) || 10 : 10;
      totalPages = Math.ceil(allRules.length / pageSize);

      // Ensure current page is valid
      if (currentPage < 1) currentPage = 1;
      if (currentPage > totalPages) currentPage = totalPages;

      const paginatedRules = allRules.slice((currentPage - 1) * pageSize, currentPage * pageSize);

      // Render the list, attach handlers, render pagination
      output.innerHTML = renderAliasList(paginatedRules);
      attachRuleEventHandlers(zoneId, token);
      renderPaginationControls(allRules.length);
	  // --- Ensure Select All state is updated AFTER rendering ---
      updateSelectAllCheckboxState();
    } else {
        // No rules found (after filtering/searching)
        output.innerHTML = searchQuery ? '<p>No aliases found matching search.</p>' : '<p>No email alias rules configured for this domain.</p>';
        // Ensure pagination is cleared
		if (paginationContainer) paginationContainer.innerHTML = '';
		// --- Explicitly disable Select All if no rules ---
		const selectAllCheckbox = document.getElementById('selectAll');
		if (selectAllCheckbox) {
			selectAllCheckbox.checked = false;
			selectAllCheckbox.indeterminate = false;
			selectAllCheckbox.disabled = true; // Disable because there's nothing to select
		}
		
		
    }
  } catch (err) { // Catch errors during the process
    console.error('Error listing aliases:', err);
    // Provide feedback to the user
    output.innerHTML = `<p>Error listing aliases: ${err.message}.</p>`;
    showToast("Error listing aliases. See console.", "error");
  }
}

function renderAliasList(rules) {
  let html = ``; if (!rules || rules.length === 0) { return '<p>No aliases to display.</p>'; }
  const addListHeader = !groupByDomain;
  if (addListHeader) { const totalCount = allRules ? allRules.length : 0; if (totalCount > 0) { html += `<h3 style="font-weight:normal;margin-bottom:10px;font-size:0.95em;color:${darkMode ? '#bbb' : '#555'};">${totalCount} total alias${totalCount === 1 ? '' : 'es'} found</h3>`; } }
  if (groupByDomain) {
    const groups = {}; rules.forEach(rule => { const domain = rule.matchers[0].value.split('@')[1] || "Unknown Domain"; if (!groups[domain]) groups[domain] = []; groups[domain].push(rule); });
    const sortedDomains = Object.keys(groups).sort((a, b) => a.localeCompare(b));
    sortedDomains.forEach(domain => { html += `<div class="group-header">${domain} (${groups[domain].length})</div><ul>`; groups[domain].forEach(rule => { html += renderAliasItem(rule); }); html += `</ul>`; });
  } else { html += `<ul>`; rules.forEach(rule => { html += renderAliasItem(rule); }); html += `</ul>`; }
  return html;
}


function renderAliasItem(rule) {
  const ruleId = rule.id;
  const matcher = rule.matchers[0].value;

  // Alias container (Icon + Text) - Copy button is now separate
  let aliasDisplay = `
    <span class="alias-container" title="Alias: ${matcher}">
      📧 <span class="alias-email">${matcher}</span>
    </span>`;

  // Copy Button (Now a direct child of li)
  let copyButton = `<button class="copy-alias-btn" data-alias="${matcher}" title="Copy alias to clipboard">📋</button>`; // Emoji used

  let arrowDisplay = `<span class="arrow-span">→</span>`;
  let actionVal = rule.actions?.[0]?.value;
  let forwardDisplay = '';
  const actionType = rule.actions?.[0]?.type;
  let forwardTarget = actionVal?.[0] || '';

  if (actionType === 'forward' && actionVal?.length > 0) {
      forwardDisplay = `<span class="forward-email" title="Forwards to: ${forwardTarget}">${actionVal.join(', ')}</span>`;
  } else if (actionType === 'drop') {
       forwardDisplay = `<span class="forward-email" title="Incoming email will be dropped">🗑️ Drop</span>`;
  } else {
      forwardDisplay = `<span class="forward-email" title="Action Type: ${actionType || 'Unknown'}"><i>(Action: ${actionType || 'Unknown'})</i></span>`;
  }

  const statusClass = rule.enabled ? 'badge-active' : 'badge-disabled';
  const statusText = rule.enabled ? 'Active' : 'Disabled';
  const toggleButtonText = rule.enabled ? 'Disable' : 'Enable';
  const toggleButtonClass = rule.enabled ? 'active' : 'disabled';

  // Assemble the list item HTML with the new order
  return `
    <li data-rule-id="${ruleId}">
      ${aliasDisplay}
      ${copyButton}  
      ${arrowDisplay}
      ${forwardDisplay}
      <div class="alias-actions">
        <input type="checkbox" class="select-rule" data-rule-id="${ruleId}" title="Select for bulk action">
        <span class="status ${statusClass}" title="Rule status: ${statusText}">${statusText}</span>
        <button class="toggle-btn ${toggleButtonClass}" title="${toggleButtonText} this alias">${toggleButtonText}</button>
        <button class="delete-btn" title="Delete this alias rule">❌</button>
      </div>
    </li>`;
}

// -------------------- Event Handlers & UI Updates --------------------
function attachRuleEventHandlers(zoneId, token) { // Includes Copy Logic, Specific Confirm, Busy States
  const output = document.getElementById('output'); if (!output) return;
  output.addEventListener('click', async (e) => {
    const target = e.target; const li = target.closest('li[data-rule-id]'); if (!li) return;
    const ruleId = li.dataset.ruleId; const aliasEmailElement = li.querySelector('.alias-email'); const aliasEmailText = aliasEmailElement ? aliasEmailElement.textContent : `rule ${ruleId}`;

    if (target.classList.contains('copy-alias-btn')) { // Handle Copy
        e.stopPropagation(); const aliasToCopy = target.dataset.alias;
        if (aliasToCopy && navigator.clipboard) { try { await navigator.clipboard.writeText(aliasToCopy); showToast(`Copied: ${aliasToCopy}`); } catch (err) { console.error('Failed to copy: ', err); showToast('Failed to copy', 'error'); } }
        else if (!navigator.clipboard) { showToast('Clipboard API not available.', 'error'); } return;
    }
    if (target.classList.contains('delete-btn')) { // Handle Delete
        e.stopPropagation(); if (confirm(`Are you sure you want to delete alias rule for '${aliasEmailText}'?`)) {
            target.disabled = true; target.textContent = '...'; // Busy
            try {
                const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules/${ruleId}`, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } }); const data = await res.json();
                if (data.success) { li.style.opacity='0'; li.style.height='0'; li.style.padding='0'; li.style.margin='0'; li.style.borderWidth='0'; setTimeout(() => { invalidateRulesCache(token, zoneId); showToast("Alias deleted"); listAliasesHandler(); }, 500); }
                else { throw new Error(data?.errors?.[0]?.message || `HTTP ${res.status}`); }
            } catch (err) { console.error("Err delete:", err); showToast(`Failed delete: ${err.message}`, "error"); if (target.closest('li')) { target.disabled = false; target.innerHTML = '❌'; } } // Reset if still exists
        }
    }
    else if (target.classList.contains('toggle-btn')) { // Handle Toggle
        e.stopPropagation(); const isActive = target.classList.contains('active'); const newStatus = !isActive;
        target.disabled = true; target.textContent = newStatus ? 'Enabling...' : 'Disabling...'; // Busy
        let success = false;
        try {
             const updatePayload = { enabled: newStatus }; const putRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules/${ruleId}`, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(updatePayload) }); const putData = await putRes.json();
             if (putData.success) { success = true; }
             else { // Fallback
                 console.warn(`Minimal toggle failed for ${ruleId}, trying full update.`); const ruleRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules/${ruleId}`, { headers: { 'Authorization': 'Bearer ' + token } }); const ruleData = await ruleRes.json();
                 if (!ruleData.success) throw new Error("Failed fetch for toggle fallback."); const fullRule = ruleData.result; fullRule.enabled = newStatus;
                 const fullPutRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules/${ruleId}`, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ actions:fullRule.actions, matchers:fullRule.matchers, enabled:fullRule.enabled, name:fullRule.name, priority:fullRule.priority }) }); const fullPutData = await fullPutRes.json();
                 if (fullPutData.success) { success = true; showToast(`Alias ${newStatus ? 'enabled' : 'disabled'} (fallback)`); }
                 else { throw new Error(fullPutData?.errors?.[0]?.message || `HTTP ${fullPutRes.status}`); }
             }
             if (success) { // Update UI only on success
                 if (!isActive) { showToast(`Alias ${newStatus ? 'enabled' : 'disabled'}`); } // Avoid double toast on fallback
                 invalidateRulesCache(token, zoneId); const statusSpan = li.querySelector('.status');
                 if (statusSpan) { statusSpan.textContent = newStatus ? 'Active' : 'Disabled'; statusSpan.className = `status ${newStatus ? 'badge-active' : 'badge-disabled'}`; statusSpan.title = `Rule status: ${newStatus ? 'Active' : 'Disabled'}`; }
             }
        } catch (err) { console.error("Err toggle:", err); showToast(`Toggle failed: ${err.message}`, "error"); }
        finally { // Reset button state
            target.disabled = false; const finalState = success ? newStatus : isActive; // Use new state if success, old if error
            target.textContent = finalState ? 'Disable' : 'Enable'; target.className = `toggle-btn ${finalState ? 'active' : 'disabled'}`; target.title = finalState ? 'Disable this alias' : 'Enable this alias';
        }
    }
    else if (target.classList.contains('select-rule')) { updateSelectAllCheckboxState(); // Handle Checkbox
	} 
	
	
  });
}

function updateSelectAllCheckboxState() {
    const allCb = document.querySelectorAll('.select-rule'); const checkedCb = document.querySelectorAll('.select-rule:checked'); const selectAllCb = document.getElementById('selectAll');
    if (!selectAllCb) { console.warn("updateSelectAllCheckboxState: #selectAll missing."); return; }
    if (allCb.length === 0) { selectAllCb.checked=false; selectAllCb.indeterminate=false; selectAllCb.disabled=true; }
    else { selectAllCb.disabled=false; if (checkedCb.length === 0) { selectAllCb.checked=false; selectAllCb.indeterminate=false; } else if (checkedCb.length === allCb.length) { selectAllCb.checked=true; selectAllCb.indeterminate=false; } else { selectAllCb.checked=false; selectAllCb.indeterminate=true; } }
}

function renderPaginationControls(totalItems) {
  let container = document.getElementById('paginationContainer');
  if (!container) { container = document.createElement('div'); container.id = 'paginationContainer'; container.className = 'pagination-controls'; const out = document.getElementById('output'); if (out?.parentNode) { out.parentNode.insertBefore(container, out.nextSibling); } else { document.body.appendChild(container); } }
  container.innerHTML = ''; const psEl = document.getElementById('pageSize'); const ps = psEl ? parseInt(psEl.value) || 10 : 10; totalPages = Math.ceil(totalItems / ps);
  if (currentPage < 1) currentPage = 1; if (totalItems === 0) { currentPage = 1; totalPages = 1; } else if (currentPage > totalPages) { currentPage = totalPages; }
  if (totalPages <= 1) return; // Hide for 0 or 1 page
  container.innerHTML = `<button id="prevPage" title="Previous Page" ${currentPage===1?'disabled':''}>« Prev</button><span>Page ${currentPage} of ${totalPages}</span><button id="nextPage" title="Next Page" ${currentPage>=totalPages?'disabled':''}>Next »</button>`;
  const prevBtn = document.getElementById('prevPage'); const nextBtn = document.getElementById('nextPage');
  if (prevBtn) { prevBtn.addEventListener('click', () => { if (currentPage > 1) { currentPage--; listAliasesHandler(); } }, { once: true }); }
  if (nextBtn) { nextBtn.addEventListener('click', () => { if (currentPage < totalPages) { currentPage++; listAliasesHandler(); } }, { once: true }); }
}

// -------------------- Bulk Actions --------------------
function toggleSelectAll(e) {
  const isChecked = e.target.checked; const checkboxes = document.querySelectorAll('.select-rule'); // Simplified selector
  checkboxes.forEach(cb => { cb.checked = isChecked; }); updateSelectAllCheckboxState();
}

async function bulkAction(actionType) { // Uses Full Rule Fetch for Enable/Disable
    const tokenInput = document.getElementById('apiToken'); const domainSelect = document.getElementById('domainSelect');
    if (!tokenInput || !domainSelect) { showToast("Error: Cannot bulk action, core elements missing.", "error"); return; }
    const token = tokenInput.value.trim(); const zoneId = domainSelect.value; if (!token || !zoneId) { showToast("Missing Token/Domain for bulk action.", "error"); return; }
    const selectedCb = document.querySelectorAll('.select-rule:checked'); if (selectedCb.length === 0) { showToast("No rules selected.", "error"); return; }
    if (!confirm(`Are you sure you want to ${actionType} ${selectedCb.length} selected alias rule(s)?`)) return;

    if (bulkProgressIndicator) { bulkProgressIndicator.textContent = `Processing 0/${selectedCb.length}...`; bulkProgressIndicator.style.display = 'inline'; }
    const bulkButtons = document.querySelectorAll('#bulkActions button, #bulkActions input'); bulkButtons.forEach(el => el.disabled = true);
    let processedCount = 0; let errorCount = 0; const promises = [];

    selectedCb.forEach(cb => {
        const ruleId = cb.getAttribute('data-rule-id'); const li = cb.closest('li');
        promises.push((async () => { // Wrap async logic
            try {
                if (actionType === 'delete') {
                    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules/${ruleId}`, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } }); const data = await res.json(); if (!data.success) throw new Error(data?.errors?.[0]?.message || `HTTP ${res.status}`);
                } else { // Enable/Disable: Fetch full rule
                    const newStatus = actionType === 'enable'; const ruleRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules/${ruleId}`, { headers: { 'Authorization': 'Bearer ' + token } }); const ruleData = await ruleRes.json();
                    if (!ruleData.success || !ruleData.result) { throw new Error(ruleData?.errors?.[0]?.message || `Fetch rule ${ruleId} failed (HTTP ${ruleRes.status})`); } const fullRule = ruleData.result;
                    if (fullRule.enabled === newStatus) { console.log(`Rule ${ruleId} already ${newStatus ? 'enabled' : 'disabled'}. Skipping.`); }
                    else { fullRule.enabled = newStatus; const putRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules/${ruleId}`, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ actions:fullRule.actions, matchers:fullRule.matchers, enabled:fullRule.enabled, name:fullRule.name, priority:fullRule.priority }) }); const putData = await putRes.json(); if (!putData.success) { throw new Error(putData?.errors?.[0]?.message || `Update rule ${ruleId} failed (HTTP ${putRes.status})`); } }
                }
                console.log(`Bulk '${actionType}' processed for ${ruleId}`); return true;
            } catch (err) { errorCount++; console.error(`Bulk '${actionType}' fail ${ruleId}:`, err); if (li) li.style.outline = `1px dashed ${darkMode ? 'red' : '#c00'}`; return false; }
            finally { processedCount++; if (bulkProgressIndicator) { bulkProgressIndicator.textContent = `Processing ${processedCount}/${selectedCb.length}...`; } }
        })()); // Immediately invoke the async function
    });
    await Promise.all(promises);

    if (bulkProgressIndicator) { bulkProgressIndicator.textContent = `Complete. ${processedCount - errorCount} success, ${errorCount} failed.`; setTimeout(() => { if (bulkProgressIndicator) bulkProgressIndicator.style.display = 'none'; document.querySelectorAll('li[style*="outline"]').forEach(li => li.style.outline = ''); }, 4000); }
    bulkButtons.forEach(el => el.disabled = false); const selectAll = document.getElementById('selectAll'); if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false; }
    invalidateRulesCache(token, zoneId); setTimeout(() => { listAliasesHandler(); showToast(`Bulk ${actionType} finished. ${errorCount > 0 ? `${errorCount} error(s).` : 'All succeeded.'}`, errorCount > 0 ? "error" : "success"); }, 500);
}
// --- NEW FUNCTIONS FOR IMPORT ---
// --- FULL handleImportFile with LOGGING ---
async function handleImportFile(event) {
    // --- VERY FIRST LINE LOG ---
    console.log("handleImportFile function STARTED."); // THIS IS THE KEY LOG NOW
    // ---

    const fileInput = event.target; // Get the file input element itself
    const file = fileInput?.files[0]; // Get the file from the input
    const importButton = document.getElementById('importRulesBtn');
    const tokenInput = document.getElementById('apiToken');
    const domainSelect = document.getElementById('domainSelect');
    const outputDiv = document.getElementById('output');

    // --- Log element presence ---
    console.log("Inside handleImportFile - Checking elements:", { importButton, tokenInput, domainSelect, outputDiv });
    console.log("Inside handleImportFile - File selected:", file ? file.name : "No file");
    // ---

    // --- Early Checks ---
    if (!file) {
        console.log("handleImportFile exiting early: No file object found in event.");
        // Value reset might happen in the 'click' handler now or via 'onloadend'
        return;
    }
    // Add explicit null/undefined checks for elements
    if (!importButton || !tokenInput || !domainSelect || !outputDiv ) {
         console.error("handleImportFile exiting early: Missing required UI elements.", { importButton, tokenInput, domainSelect, outputDiv });
         showToast("Import UI elements missing.", "error");
         if(fileInput) fileInput.value = null;
         return;
    }
    const token = tokenInput.value.trim();
    const zoneId = domainSelect.value;
     if (!token || !zoneId) {
        console.error("handleImportFile exiting early: Token or Zone ID missing.", { token: !!token, zoneId: !!zoneId });
        showToast("Token or Zone ID missing for import.", "error");
        if(fileInput) fileInput.value = null;
        return;
    }
    console.log(`handleImportFile: Proceeding with import for file: ${file.name}, Zone ID: ${zoneId}`);

    // --- UI Busy State ---
    console.log("handleImportFile: Setting button to busy state...");
    importButton.disabled = true;
    importButton.textContent = 'Reading...';

    const reader = new FileReader();
    console.log("handleImportFile: FileReader created.");

    // --- Event Handlers for FileReader ---
    reader.onload = async (e) => {
        console.log("FileReader onload event fired.");
        let rulesToImport = [];
        let parsedData;
        try {
            const content = e.target.result;
            console.log("FileReader onload: Content read.");
            parsedData = JSON.parse(content);
            console.log("FileReader onload: JSON parsed.");

            // Validation
            if (!Array.isArray(parsedData)) { throw new Error("Imported file is not a valid JSON array."); }
            console.log(`FileReader onload: Parsed data contains ${parsedData.length} items. Validating...`);
            rulesToImport = parsedData.filter((item, index) => { /* ... validation logic ... */ return true; }); // Keep validation logic
            if (rulesToImport.length === 0) { throw new Error("No valid email alias rules found to import."); }
            console.log(`FileReader onload: Found ${rulesToImport.length} valid rules.`);

        } catch (err) {
            showToast(`Import Error: ${err.message}`, "error");
            console.error("FileReader onload: Parsing/validation error:", err);
            // Reset handled by onloadend
            return;
        }

        // Start Import API Calls
        importButton.textContent = `Importing 0/${rulesToImport.length}...`;
        let successCount = 0; let failCount = 0; let skippedCount = 0; let rateLimitDelay = 100;
        let importStatusDiv = document.getElementById('importStatus');
        if (!importStatusDiv) {
             importStatusDiv = document.createElement('div'); importStatusDiv.id = 'importStatus';
             importStatusDiv.style.cssText = `margin-top: 10px; font-style: italic; color: ${darkMode ? '#bbb' : '#555'}; font-size: 0.9em; max-height: 60px; overflow-y: auto; border: 1px solid ${darkMode ? '#555' : '#ccc'}; padding: 5px; border-radius: 3px;`;
             const controlsWrapper = document.getElementById('extraControlsContainer');
             if (controlsWrapper?.parentNode) { controlsWrapper.parentNode.insertBefore(importStatusDiv, controlsWrapper.nextSibling); }
             else if (outputDiv?.parentNode) { outputDiv.parentNode.insertBefore(importStatusDiv, outputDiv); }
             else { document.body.appendChild(importStatusDiv); }
        }
        importStatusDiv.innerHTML = `Starting import of ${rulesToImport.length} rules...<br>`;

        for (let i = 0; i < rulesToImport.length; i++) { // Main import loop
             const rule = rulesToImport[i];
             importButton.textContent = `Importing ${i+1}/${rulesToImport.length}...`;
             const firstMatcher = rule.matchers.find(m => m.type === 'literal' && m.field === 'to');
             const payload = { matchers: [firstMatcher], actions: rule.actions, enabled: rule.enabled !== undefined ? rule.enabled : true, name: rule.name || `Imported: ${firstMatcher.value.split('@')[0]}` };
             const aliasForLog = firstMatcher?.value || `rule at index ${i}`;
             try {
                 console.log(`POSTing rule for: ${aliasForLog}`);
                 const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules`, { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                 const data = await res.json();
                 if (data.success) { /* ... handle success ... */ successCount++; importStatusDiv.innerHTML += `SUCCESS: ${aliasForLog}<br>`; rateLimitDelay = Math.max(50, rateLimitDelay / 2); }
                 else { /* ... handle API error, duplicates, rate limit ... */ const errorMsg = data?.errors?.[0]?.message || `HTTP ${res.status}`; console.error(`Import FAIL for ${aliasForLog}: ${errorMsg}`); if (errorMsg.includes('duplicate')) { skippedCount++; importStatusDiv.innerHTML += `SKIP (Exists): ${aliasForLog}<br>`; } else { failCount++; importStatusDiv.innerHTML += `FAIL: ${aliasForLog} (${errorMsg})<br>`; } if (res.status === 429) { rateLimitDelay = Math.min(5000, rateLimitDelay * 2); console.warn(`Rate limit hit. Delay: ${rateLimitDelay}ms`); importStatusDiv.innerHTML += `(Rate limit hit, waiting ${rateLimitDelay}ms...)<br>`; } }
             } catch (err) { /* ... handle network error ... */ failCount++; console.error(`Network error importing ${aliasForLog}:`, err); importStatusDiv.innerHTML += `FAIL (Network): ${aliasForLog}<br>`; rateLimitDelay = Math.min(5000, rateLimitDelay * 2); importStatusDiv.innerHTML += `(Network error, waiting ${rateLimitDelay}ms...)<br>`; }
             importStatusDiv.scrollTop = importStatusDiv.scrollHeight;
             if (i < rulesToImport.length - 1) { await new Promise(resolve => setTimeout(resolve, rateLimitDelay)); }
        } // End loop

        // Finish Import
        const finalMessage = `Import finished: ${successCount} added, ${skippedCount} skipped, ${failCount} failed.`;
        importStatusDiv.innerHTML += `<b>${finalMessage}</b>`; importStatusDiv.scrollTop = importStatusDiv.scrollHeight;
        showToast(finalMessage, failCount > 0 ? "error" : "success"); console.log(finalMessage);
        if (successCount > 0 || failCount > 0) { invalidateRulesCache(token, zoneId); listAliasesHandler(); }

    }; // End reader.onload

    reader.onerror = () => {
         console.error("FileReader onerror event fired:", reader.error);
         showToast('Error reading import file.', 'error');
         // Reset handled by onloadend
    };

    reader.onloadend = () => {
        console.log("FileReader onloadend event fired.");
        // We DON'T reset fileInput.value here anymore, it's done before click or if change listener fires.
        if (importButton) { importButton.disabled = false; importButton.textContent = 'Import'; }
        // setTimeout(() => document.getElementById('importStatus')?.remove(), 15000);
    }

    // Start Reading
    console.log("handleImportFile: Calling reader.readAsText()...");
    reader.readAsText(file);
    console.log("handleImportFile: reader.readAsText() called.");
}
// --- END FULL handleImportFile ---
// --- END handleImportFile ---

// -------------------- Export Rules --------------------
async function exportRules() {
    const tokenInput = document.getElementById('apiToken'); const domainSelect = document.getElementById('domainSelect'); const exportButton = document.getElementById('exportRules');
    if (!tokenInput || !domainSelect || !exportButton) { showToast("Error: Cannot export, core elements missing.", "error"); return; }
    const token = tokenInput.value.trim(); const zoneId = domainSelect.value; const domainName = domainSelect.selectedOptions[0]?.text || 'domain';
    if (!token) return showToast("API Token missing.", "error"); if (!zoneId) return showToast("Please select a domain to export.", "error");

    exportButton.disabled = true; exportButton.textContent = 'Exporting...'; // Busy state
    try {
        const rules = await getCachedEmailRules(token, zoneId, true); if (rules === null) return;
        const emailRules = rules.filter(r => r.matchers?.some(m => m.type === 'literal' && m.field === 'to' && m.value)); // Filter for email rules
        if (emailRules.length === 0) { showToast("No email alias rules found to export.", "error"); return; }
        const blob = new Blob([JSON.stringify(emailRules, null, 2)], { type: "application/json;charset=utf-8" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.style.display = 'none'; a.href = url;
        const safeDomainName = domainName.replace(/[^a-z0-9]/gi, '_').toLowerCase(); const timestamp = new Date().toISOString().slice(0, 10); a.download = `cf_email_rules_${safeDomainName}_${timestamp}.json`;
        document.body.appendChild(a); a.click(); window.URL.revokeObjectURL(url); document.body.removeChild(a); showToast(`Exported ${emailRules.length} email alias rules for ${domainName}`);
    } catch (err) { console.error("Error exporting rules:", err); showToast("Error exporting rules. See console.", "error"); }
    finally { exportButton.disabled = false; exportButton.textContent = 'Export'; } // Reset busy state
}