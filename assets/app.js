let currentUser = null;
let currentProfile = null;
let products = [];
let sales = [];
let movements = [];
let settings = { monthly_rent: 0 };
let pastelSyncJobs = [];
let pastelSyncAvailable = true;
let receiptItems = [];
const PASTEL_SYNC_SOURCE = "liquor-republic-pos";

function money(value) {
  return "$" + Number(value || 0).toFixed(2);
}

function showMessage(id, text, type = "success") {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<div class="${type}">${text}</div>`;
  setTimeout(() => el.innerHTML = "", 5000);
}

function isSupervisor() {
  return currentProfile && currentProfile.role === "supervisor";
}

function openPanel(panelId) {
  if (panelId === "pastelPanel") {
    setDefaultPastelDates();
    updatePastelPreview();
  }

  document.querySelectorAll(".panel").forEach(panel => {
    panel.classList.remove("active-panel");
  });

  const selected = document.getElementById(panelId);
  if (selected) selected.classList.add("active-panel");

  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.classList.remove("active");
  });

  const clicked = Array.from(document.querySelectorAll(".nav-btn"))
    .find(btn => btn.getAttribute("onclick") && btn.getAttribute("onclick").includes(panelId));

  if (clicked) clicked.classList.add("active");
}

async function login() {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

  if (error) {
    showMessage("loginMessage", error.message, "error");
    return;
  }

  currentUser = data.user;
  await loadProfile();
  await loadAll();
  render();
  renderReceipt();
  renderPastelSyncStatus();
  updatePastelPreview();
}

async function logout() {
  await supabaseClient.auth.signOut();
  currentUser = null;
  currentProfile = null;
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
}

async function loadProfile() {
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", currentUser.id)
    .single();

  if (error) {
    alert("Profile not found. Add this user to the profiles table.");
    await logout();
    return;
  }

  currentProfile = data;
}

async function loadAll() {
  await Promise.all([
    loadProducts(),
    loadSales(),
    loadMovements(),
    loadSettings(),
    loadPastelSyncJobs()
  ]);
}

async function loadProducts() {
  const { data, error } = await supabaseClient
    .from("products")
    .select("*")
    .order("name", { ascending: true });

  if (!error) products = data || [];
}

async function loadSales() {
  const { data, error } = await supabaseClient
    .from("sales")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (!error) sales = data || [];
}

async function loadMovements() {
  const { data, error } = await supabaseClient
    .from("stock_movements")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (!error) movements = data || [];
}

async function loadSettings() {
  const { data, error } = await supabaseClient
    .from("settings")
    .select("*")
    .eq("setting_key", "monthly_rent")
    .single();

  if (!error && data) settings.monthly_rent = Number(data.setting_value || 0);
}

async function loadPastelSyncJobs() {
  if (!pastelSyncAvailable) return;

  const { data, error } = await supabaseClient
    .from("pastel_sync_queue")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    pastelSyncAvailable = false;
    pastelSyncJobs = [];
    console.warn("Pastel sync queue is not installed yet:", error.message);
    return;
  }

  pastelSyncJobs = data || [];
}

function getProductById(productId) {
  return products.find(p => String(p.id) === String(productId));
}

function currencySymbol() {
  const currency = document.getElementById("saleCurrency")?.value || "USD";
  return currency === "ZWG" ? "ZWG " : "$";
}

function moneyForSale(value) {
  return currencySymbol() + Number(value || 0).toFixed(2);
}

function receiptTotal() {
  return receiptItems.reduce((sum, item) => sum + Number(item.line_total || 0), 0);
}

function receiptItemCount() {
  return receiptItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
}

function onSaleProductChange() {
  const product = getProductById(document.getElementById("saleProduct")?.value);
  const qtyInput = document.getElementById("saleQuantity");
  const hint = document.getElementById("saleProductHint");

  if (qtyInput) qtyInput.value = "1";
  if (qtyInput && product) qtyInput.max = Number(product.quantity || 0);
  if (hint && product) {
    hint.textContent = `${product.name}: ${product.quantity} available at ${money(product.selling_price)} each.`;
  }
}

function handleSaleQuantityKey(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    addProductToReceipt();
  }
}

function addProductToReceipt() {
  const productId = document.getElementById("saleProduct").value;
  const quantity = Number(document.getElementById("saleQuantity").value || 1);
  const product = getProductById(productId);

  if (!product) {
    showMessage("saleMessage", "Select a product first.", "error");
    return;
  }

  if (!Number.isFinite(quantity) || quantity <= 0) {
    showMessage("saleMessage", "Enter a valid quantity.", "error");
    return;
  }

  if (!Number.isInteger(quantity)) {
    showMessage("saleMessage", "Quantity must be a whole number.", "error");
    return;
  }

  const existing = receiptItems.find(item => item.product_id === product.id);
  const currentReceiptQty = existing ? Number(existing.quantity || 0) : 0;
  const requestedTotalQty = currentReceiptQty + quantity;
  const stockAvailable = Number(product.quantity || 0);

  if (requestedTotalQty > stockAvailable) {
    showMessage("saleMessage", `Insufficient stock. ${product.name} has only ${stockAvailable} available.`, "error");
    return;
  }

  if (existing) {
    existing.quantity = requestedTotalQty;
    existing.line_total = Number((existing.quantity * existing.unit_price).toFixed(2));
  } else {
    receiptItems.push({
      product_id: product.id,
      product_name: product.name,
      quantity,
      unit_price: Number(product.selling_price || 0),
      cost_price: Number(product.cost_price || 0),
      vat_rate: Number(product.vat_rate || 15),
      line_total: Number((quantity * Number(product.selling_price || 0)).toFixed(2))
    });
  }

  document.getElementById("saleQuantity").value = "1";
  showMessage("saleMessage", `${product.name} added to receipt.`);
  renderReceipt();
}

function removeReceiptItem(productId) {
  receiptItems = receiptItems.filter(item => String(item.product_id) !== String(productId));
  renderReceipt();
}

function clearReceipt() {
  receiptItems = [];
  const amountReceived = document.getElementById("amountReceived");
  if (amountReceived) amountReceived.value = "";
  renderReceipt();
  showMessage("saleMessage", "Receipt cleared.");
}

function renderReceipt() {
  const table = document.getElementById("receiptItemsTable");
  if (!table) return;

  table.innerHTML = "";
  receiptItems.forEach(item => {
    table.innerHTML += `
      <tr>
        <td>${item.product_name}</td>
        <td>${item.quantity}</td>
        <td>${moneyForSale(item.unit_price)}</td>
        <td>${moneyForSale(item.line_total)}</td>
        <td><button class="danger small-btn" onclick="removeReceiptItem('${item.product_id}')">Remove</button></td>
      </tr>
    `;
  });

  if (!table.innerHTML) {
    table.innerHTML = `<tr><td colspan="5">No products added yet. Select a product above and press Enter or Add.</td></tr>`;
  }

  updateReceiptTotals();
}

function updateReceiptTotals() {
  const total = receiptTotal();
  const itemCount = receiptItemCount();

  const grandTotal = document.getElementById("receiptGrandTotal");
  const receiptCount = document.getElementById("receiptItemCount");
  const paymentTotal = document.getElementById("paymentTotal");

  if (grandTotal) grandTotal.textContent = moneyForSale(total);
  if (receiptCount) receiptCount.textContent = itemCount;
  if (paymentTotal) paymentTotal.textContent = moneyForSale(total);

  renderReceiptOnlyTotals();
  updatePaymentPreview();
}

function renderReceiptOnlyTotals() {
  const table = document.getElementById("receiptItemsTable");
  if (!table || !receiptItems.length) return;

  Array.from(table.querySelectorAll("tr")).forEach((row, index) => {
    const item = receiptItems[index];
    if (!item) return;
    const cells = row.querySelectorAll("td");
    if (cells.length >= 4) {
      cells[2].textContent = moneyForSale(item.unit_price);
      cells[3].textContent = moneyForSale(item.line_total);
    }
  });
}

function onPaymentMethodChange() {
  const method = document.getElementById("paymentMethod")?.value || "CASH";
  const amountInput = document.getElementById("amountReceived");
  if (amountInput && method !== "CASH") {
    amountInput.value = receiptTotal().toFixed(2);
  }
  updatePaymentPreview();
}

function updatePaymentPreview() {
  const total = receiptTotal();
  const amount = Number(document.getElementById("amountReceived")?.value || 0);
  const method = document.getElementById("paymentMethod")?.value || "CASH";
  const change = method === "CASH" && amount > total ? amount - total : 0;

  const amountEl = document.getElementById("paymentAmountReceived");
  const changeEl = document.getElementById("paymentChange");
  if (amountEl) amountEl.textContent = moneyForSale(amount);
  if (changeEl) changeEl.textContent = moneyForSale(change);
}

function validatePayment() {
  const total = receiptTotal();
  const amount = Number(document.getElementById("amountReceived")?.value || 0);
  const method = document.getElementById("paymentMethod")?.value || "CASH";

  if (receiptItems.length === 0) {
    showMessage("saleMessage", "Add at least one product to the receipt first.", "error");
    return false;
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    showMessage("saleMessage", "Enter the amount received.", "error");
    return false;
  }

  if (amount < total) {
    showMessage("saleMessage", "Amount received is less than the total cost of goods.", "error");
    return false;
  }

  if (method !== "CASH" && Number(amount.toFixed(2)) !== Number(total.toFixed(2))) {
    showMessage("saleMessage", "For POS / EcoCash payments, amount received must be exactly equal to the total cost.", "error");
    return false;
  }

  return true;
}

async function fetchSaleItems(saleId) {
  const { data, error } = await supabaseClient
    .from("sale_items")
    .select("*")
    .eq("sale_id", saleId)
    .order("description", { ascending: true });

  if (error) {
    console.warn("Could not load sale items:", error.message);
    return [];
  }

  return data || [];
}

async function recordSale() {
  if (!validatePayment()) return;

  const currency = document.getElementById("saleCurrency")?.value || "USD";
  const paymentMethod = document.getElementById("paymentMethod")?.value || "CASH";
  const amountReceived = Number(document.getElementById("amountReceived")?.value || 0);

  const { data: saleId, error } = await supabaseClient.rpc("record_invoice_sale_rpc", {
    p_items: receiptItems.map(item => ({ product_id: item.product_id, quantity: item.quantity })),
    p_currency: currency,
    p_payment_method: paymentMethod,
    p_amount_received: amountReceived
  });

  if (error) {
    showMessage("saleMessage", error.message, "error");
    return;
  }

  await loadAll();

  const recordedSale = sales.find(s => String(s.id) === String(saleId)) || sales[0];
  if (recordedSale) {
    recordedSale.items = await fetchSaleItems(recordedSale.id);
    await enqueuePastelSync("sale_invoice", "sales", recordedSale.id, buildPastelSalePayload(recordedSale));
    await loadPastelSyncJobs();
  }

  const total = receiptTotal();
  const change = paymentMethod === "CASH" && amountReceived > total ? amountReceived - total : 0;
  receiptItems = [];
  document.getElementById("amountReceived").value = "";
  renderReceipt();
  await loadAll();
  showMessage("saleMessage", `Sale recorded successfully. ${change > 0 ? `Change: ${currencySymbol()}${change.toFixed(2)}.` : ""} Queued for ZIMRA and Pastel sync.`);
  render();
}

async function receiveStock() {
  if (!isSupervisor()) return;

  const name = document.getElementById("productName").value.trim();
  const cost = Number(document.getElementById("costPrice").value);
  const selling = Number(document.getElementById("sellingPrice").value);
  const quantity = Number(document.getElementById("quantity").value);
  const alertLevel = Number(document.getElementById("alertLevel").value);

  const { error } = await supabaseClient.rpc("receive_stock_rpc", {
    p_name: name,
    p_cost_price: cost,
    p_selling_price: selling,
    p_quantity: quantity,
    p_alert_level: alertLevel
  });

  if (error) {
    showMessage("stockMessage", error.message, "error");
    return;
  }

  document.getElementById("productName").value = "";
  document.getElementById("costPrice").value = "";
  document.getElementById("sellingPrice").value = "";
  document.getElementById("quantity").value = "";
  document.getElementById("alertLevel").value = "5";

  await loadAll();

  const latestMovement = movements[0];
  if (latestMovement) {
    await enqueuePastelSync("stock_movement", "stock_movements", latestMovement.id || `${latestMovement.created_at}-${latestMovement.product_id}`, buildPastelMovementPayload(latestMovement));
    await loadPastelSyncJobs();
  }

  showMessage("stockMessage", "Stock received successfully and queued for Pastel sync.");
  render();
}

async function deductStock() {
  if (!isSupervisor()) return;

  const productId = document.getElementById("deductProduct").value;
  const quantity = Number(document.getElementById("deductQuantity").value);
  const reason = document.getElementById("deductReason").value.trim();

  const { error } = await supabaseClient.rpc("deduct_stock_rpc", {
    p_product_id: productId,
    p_quantity: quantity,
    p_reason: reason
  });

  if (error) {
    alert(error.message);
    return;
  }

  document.getElementById("deductQuantity").value = "";
  document.getElementById("deductReason").value = "";
  await loadAll();

  const latestMovement = movements[0];
  if (latestMovement) {
    await enqueuePastelSync("stock_movement", "stock_movements", latestMovement.id || `${latestMovement.created_at}-${latestMovement.product_id}`, buildPastelMovementPayload(latestMovement));
    await loadPastelSyncJobs();
  }

  render();
}

async function stockTake() {
  if (!isSupervisor()) return;

  const productId = document.getElementById("stockTakeProduct").value;
  const actualQuantity = Number(document.getElementById("stockTakeQuantity").value);

  const { error } = await supabaseClient.rpc("stock_take_rpc", {
    p_product_id: productId,
    p_actual_quantity: actualQuantity
  });

  if (error) {
    alert(error.message);
    return;
  }

  document.getElementById("stockTakeQuantity").value = "";
  await loadAll();

  const latestMovement = movements[0];
  if (latestMovement) {
    await enqueuePastelSync("stock_movement", "stock_movements", latestMovement.id || `${latestMovement.created_at}-${latestMovement.product_id}`, buildPastelMovementPayload(latestMovement));
    await loadPastelSyncJobs();
  }

  render();
}

async function saveSettings() {
  if (!isSupervisor()) return;

  const monthlyRent = Number(document.getElementById("monthlyRent").value || 0);

  const { error } = await supabaseClient
    .from("settings")
    .update({ setting_value: monthlyRent, updated_at: new Date().toISOString() })
    .eq("setting_key", "monthly_rent");

  if (error) {
    alert(error.message);
    return;
  }

  settings.monthly_rent = monthlyRent;
  alert("Settings saved.");
  render();
}

async function changePassword() {
  const oldPassword = document.getElementById("oldPassword").value;
  const newPassword = document.getElementById("newPassword").value;
  const confirmNewPassword = document.getElementById("confirmNewPassword").value;

  if (!oldPassword || !newPassword || !confirmNewPassword) {
    showMessage("passwordMessage", "Fill in all password fields.", "error");
    return;
  }

  if (newPassword.length < 6) {
    showMessage("passwordMessage", "New password must be at least 6 characters.", "error");
    return;
  }

  if (newPassword !== confirmNewPassword) {
    showMessage("passwordMessage", "New passwords do not match.", "error");
    return;
  }

  const { error: verifyError } = await supabaseClient.auth.signInWithPassword({
    email: currentUser.email,
    password: oldPassword
  });

  if (verifyError) {
    showMessage("passwordMessage", "Old password is incorrect.", "error");
    return;
  }

  const { error } = await supabaseClient.auth.updateUser({
    password: newPassword
  });

  if (error) {
    showMessage("passwordMessage", error.message, "error");
    return;
  }

  document.getElementById("oldPassword").value = "";
  document.getElementById("newPassword").value = "";
  document.getElementById("confirmNewPassword").value = "";

  showMessage("passwordMessage", "Password changed successfully.");
}

function getPeriodSales(period) {
  const now = new Date();

  return sales.filter(s => {
    const d = new Date(s.created_at);

    if (period === "daily") return d.toDateString() === now.toDateString();

    if (period === "weekly") {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(now.getDate() - 7);
      return d >= sevenDaysAgo && d <= now;
    }

    if (period === "monthly") {
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }

    return false;
  });
}

function calculateReport(period) {
  const periodSales = getPeriodSales(period);
  const revenue = periodSales.reduce((sum, s) => sum + Number(s.revenue), 0);
  const productCost = periodSales.reduce((sum, s) => sum + Number(s.product_cost), 0);
  const grossProfit = periodSales.reduce((sum, s) => sum + Number(s.gross_profit), 0);

  const monthlyRent = Number(settings.monthly_rent || 0);
  const dailyRent = monthlyRent / 30;
  const rent = period === "daily" ? dailyRent : period === "weekly" ? dailyRent * 7 : monthlyRent;
  const netProfit = grossProfit - rent;

  const productTotals = {};
  periodSales.forEach(s => {
    productTotals[s.product_name] = (productTotals[s.product_name] || 0) + Number(s.quantity);
  });

  let topProduct = "No sales yet";
  let highestQty = 0;

  Object.entries(productTotals).forEach(([name, qty]) => {
    if (qty > highestQty) {
      highestQty = qty;
      topProduct = `${name} (${qty} sold)`;
    }
  });

  const averageProfitPerDay =
    period === "daily" ? netProfit :
    period === "weekly" ? netProfit / 7 :
    netProfit / 30;

  return { revenue, productCost, grossProfit, rent, netProfit, averageProfitPerDay, topProduct, numberOfSales: periodSales.length };
}

function showReport(period) {
  const report = calculateReport(period);

  document.getElementById("report").innerHTML = `
    <h3>${period.charAt(0).toUpperCase() + period.slice(1)} Report</h3>
    <div class="metrics">
      <div class="metric">Sales Revenue<strong>${money(report.revenue)}</strong></div>
      <div class="metric">Product Cost<strong>${money(report.productCost)}</strong></div>
      <div class="metric">Gross Profit<strong>${money(report.grossProfit)}</strong></div>
      <div class="metric">Rent Deducted<strong>${money(report.rent)}</strong></div>
      <div class="metric">Net Profit<strong>${money(report.netProfit)}</strong></div>
      <div class="metric">Average Profit / Day<strong>${money(report.averageProfitPerDay)}</strong></div>
      <div class="metric">Most Sought Product<strong>${report.topProduct}</strong></div>
      <div class="metric">Number of Sales<strong>${report.numberOfSales}</strong></div>
    </div>
  `;
}

function fillDropdowns() {
  const ids = ["saleProduct", "deductProduct", "stockTakeProduct"];

  ids.forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = "";

    products.forEach(p => {
      const disabled = Number(p.quantity || 0) <= 0 ? "disabled" : "";
      select.innerHTML += `<option value="${p.id}" ${disabled}>${p.name} — ${p.quantity} left — ${money(p.selling_price)}</option>`;
    });
  });

  if (document.getElementById("saleProduct")) onSaleProductChange();
  renderReceipt();
}

function render() {
  if (!currentUser || !currentProfile) return;

  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");

  document.getElementById("userInfo").textContent = `${currentProfile.full_name} — ${currentProfile.role}`;

  document.querySelectorAll(".supervisor-only").forEach(el => {
    el.classList.toggle("hidden", !isSupervisor());
  });

  fillDropdowns();

  document.getElementById("productCount").textContent = products.length;
  document.getElementById("monthlyRent").value = settings.monthly_rent || 0;

  const today = calculateReport("daily");
  document.getElementById("todaySales").textContent = money(today.revenue);
  document.getElementById("todayProfit").textContent = money(today.netProfit);
  document.getElementById("topProduct").textContent = today.topProduct;

  const alerts = document.getElementById("alerts");
  alerts.innerHTML = "";

  products.forEach(p => {
    if (Number(p.quantity) <= Number(p.alert_level)) {
      alerts.innerHTML += `<div class="alert">${p.name} has only ${p.quantity} left. Restock soon.</div>`;
    }
  });

  if (!alerts.innerHTML) {
    alerts.innerHTML = `<div class="good">All products have enough stock.</div>`;
  }

  const stockTable = document.getElementById("stockTable");
  stockTable.innerHTML = "";

  products.forEach(p => {
    stockTable.innerHTML += `
      <tr>
        <td>${p.name}</td>
        <td>${money(p.cost_price)}</td>
        <td>${money(p.selling_price)}</td>
        <td>${p.quantity}</td>
        <td>${p.alert_level}</td>
      </tr>
    `;
  });

  const salesTable = document.getElementById("salesTable");
  salesTable.innerHTML = "";

  sales.slice(0, 50).forEach(s => {
    const currency = s.currency || "USD";
    const prefix = currency === "ZWG" ? "ZWG " : "$";
    salesTable.innerHTML += `
      <tr>
        <td>${new Date(s.created_at).toLocaleString()}</td>
        <td>${s.receipt_number || ""}</td>
        <td>${s.product_name || "Sale"}</td>
        <td>${s.quantity}</td>
        <td>${currency}</td>
        <td>${s.payment_method || ""}</td>
        <td>${prefix}${Number(s.revenue || 0).toFixed(2)}</td>
        <td>${prefix}${Number(s.gross_profit || 0).toFixed(2)}</td>
      </tr>
    `;
  });

  const movementTable = document.getElementById("movementTable");
  movementTable.innerHTML = "";

  movements.slice(0, 50).forEach(m => {
    movementTable.innerHTML += `
      <tr>
        <td>${new Date(m.created_at).toLocaleString()}</td>
        <td>${m.movement_type}</td>
        <td>${m.product_name}</td>
        <td>${m.quantity_change}</td>
        <td>${m.reason || ""}</td>
      </tr>
    `;
  });

  renderReceipt();
  renderPastelSyncStatus();
  updatePastelPreview();
}


/* =========================
   Sage Pastel CSV Integration
   =========================
   This integration is designed for small shops that use Liquor Republic POS for daily
   selling and Sage Pastel / Sage 50cloud Pastel for accounting.

   It does not write directly into the Pastel database. Instead it generates
   clean CSV files that can be imported into Pastel and mapped to your company's
   import layout. This is safer for small businesses and avoids corrupting a
   Pastel company file.
*/

function buildPastelSalePayload(sale) {
  const cfg = getPastelSettings();
  const qty = Number(sale.quantity || 0);
  const revenue = Number(sale.revenue || 0);
  const unitPrice = qty ? revenue / qty : 0;
  const items = Array.isArray(sale.items) && sale.items.length
    ? sale.items.map(item => ({
        itemCode: item.product_id || item.description,
        itemDescription: item.description,
        quantity: Number(item.quantity || 0),
        unitPriceExcl: Number(item.unit_price || 0),
        taxCode: cfg.taxCode || "0",
        taxAmount: 0,
        lineTotalIncl: Number(item.line_total || 0)
      }))
    : [{
        itemCode: sale.product_id || sale.product_name,
        itemDescription: sale.product_name,
        quantity: qty,
        unitPriceExcl: Number(unitPrice.toFixed(2)),
        taxCode: cfg.taxCode || "0",
        taxAmount: 0,
        lineTotalIncl: Number(revenue.toFixed(2))
      }];

  return {
    type: "sale_invoice",
    source: PASTEL_SYNC_SOURCE,
    documentNo: sale.receipt_number || pastelDocumentNumber(sale, 0),
    documentDate: pastelDate(sale.created_at),
    customerCode: cfg.customerCode || "CASH001",
    customerName: sale.customer_name || "Cash Customer",
    currency: sale.currency || "USD",
    paymentMethod: sale.payment_method || "CASH",
    amountReceived: Number(sale.amount_received || 0),
    changeAmount: Number(sale.change_amount || 0),
    itemCode: items[0]?.itemCode,
    itemDescription: items[0]?.itemDescription,
    quantity: qty,
    unitPriceExcl: Number(unitPrice.toFixed(2)),
    taxCode: cfg.taxCode || "0",
    taxAmount: 0,
    lineTotalIncl: Number(revenue.toFixed(2)),
    lines: items,
    salesAccount: cfg.salesAccount || "4000/000",
    reference: "Liquor Republic POS multi-item sale",
    raw: sale
  };
}

function buildPastelMovementPayload(movement) {
  return {
    type: "stock_movement",
    source: PASTEL_SYNC_SOURCE,
    movementDate: pastelDate(movement.created_at),
    movementType: movement.movement_type,
    itemCode: movement.product_id || movement.product_name,
    itemDescription: movement.product_name,
    quantityChange: Number(movement.quantity_change || 0),
    reason: movement.reason || "Liquor Republic POS stock movement",
    reference: "Liquor Republic POS real-time stock",
    raw: movement
  };
}

async function enqueuePastelSync(jobType, sourceTable, sourceId, payload) {
  if (!pastelSyncAvailable || !sourceId) return;

  const { error } = await supabaseClient
    .from("pastel_sync_queue")
    .upsert({
      job_type: jobType,
      source_table: sourceTable,
      source_id: String(sourceId),
      payload,
      status: "pending",
      attempts: 0,
      created_by: currentUser?.id || null,
      updated_at: new Date().toISOString()
    }, { onConflict: "source_table,source_id,job_type" });

  if (error) {
    pastelSyncAvailable = false;
    console.warn("Pastel sync queue failed:", error.message);
  }
}

async function retryPastelJob(jobId) {
  if (!jobId) return;

  const { error } = await supabaseClient
    .from("pastel_sync_queue")
    .update({ status: "pending", error_message: null, updated_at: new Date().toISOString() })
    .eq("id", jobId);

  if (error) {
    showMessage("pastelSyncMessage", error.message, "error");
    return;
  }

  await loadPastelSyncJobs();
  renderPastelSyncStatus();
  showMessage("pastelSyncMessage", "Job placed back in the Pastel sync queue.");
}

async function refreshPastelSyncStatus() {
  pastelSyncAvailable = true;
  await loadPastelSyncJobs();
  renderPastelSyncStatus();
  showMessage("pastelSyncMessage", "Pastel sync status refreshed.");
}

function syncStatusBadge(status) {
  const safe = String(status || "pending").toLowerCase();
  return `<span class="sync-badge sync-${safe}">${safe}</span>`;
}

function renderPastelSyncStatus() {
  const table = document.getElementById("pastelSyncTable");
  if (!table) return;

  const pending = pastelSyncJobs.filter(j => j.status === "pending").length;
  const synced = pastelSyncJobs.filter(j => j.status === "synced").length;
  const failed = pastelSyncJobs.filter(j => j.status === "failed").length;

  document.getElementById("pastelPendingCount").textContent = pending;
  document.getElementById("pastelSyncedCount").textContent = synced;
  document.getElementById("pastelFailedCount").textContent = failed;
  document.getElementById("pastelQueueAvailable").textContent = pastelSyncAvailable ? "Installed" : "Not installed";

  if (!pastelSyncAvailable) {
    table.innerHTML = `<tr><td colspan="6">Pastel sync queue table is not installed yet. Run <strong>supabase-pastel-sync.sql</strong> in Supabase SQL Editor.</td></tr>`;
    return;
  }

  table.innerHTML = "";
  pastelSyncJobs.slice(0, 30).forEach(job => {
    const payload = job.payload || {};
    table.innerHTML += `
      <tr>
        <td>${new Date(job.created_at).toLocaleString()}</td>
        <td>${job.job_type}</td>
        <td>${payload.documentNo || payload.itemDescription || job.source_id}</td>
        <td>${syncStatusBadge(job.status)}</td>
        <td>${job.attempts || 0}</td>
        <td>${job.status === "failed" ? `<button onclick="retryPastelJob('${job.id}')">Retry</button>` : (job.error_message || "")}</td>
      </tr>
    `;
  });

  if (!table.innerHTML) {
    table.innerHTML = `<tr><td colspan="6">No Pastel sync jobs yet. New sales and stock movements will appear here automatically.</td></tr>`;
  }
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function ymd(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function pastelDate(date) {
  const d = new Date(date);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function cleanCsvValue(value) {
  const text = String(value ?? "").replace(/\r?\n|\r/g, " ");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(rows) {
  return rows.map(row => row.map(cleanCsvValue).join(",")).join("\n");
}

function downloadCsv(filename, rows) {
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function getPastelSettings() {
  return {
    fromDate: document.getElementById("pastelFromDate")?.value,
    toDate: document.getElementById("pastelToDate")?.value,
    customerCode: document.getElementById("pastelCustomerCode")?.value.trim() || "CASH001",
    salesAccount: document.getElementById("pastelSalesAccount")?.value.trim() || "4000/000",
    taxCode: document.getElementById("pastelTaxCode")?.value.trim() || "0",
    docPrefix: document.getElementById("pastelDocPrefix")?.value.trim() || "MIL"
  };
}

function setDefaultPastelDates() {
  const from = document.getElementById("pastelFromDate");
  const to = document.getElementById("pastelToDate");
  if (!from || !to) return;

  const today = ymd(new Date());
  if (!from.value) from.value = today;
  if (!to.value) to.value = today;
}

function salesInPastelPeriod() {
  const cfg = getPastelSettings();
  if (!cfg.fromDate || !cfg.toDate) return [];

  const from = new Date(cfg.fromDate + "T00:00:00");
  const to = new Date(cfg.toDate + "T23:59:59");

  return sales.filter(s => {
    const d = new Date(s.created_at);
    return d >= from && d <= to;
  }).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function movementsInPastelPeriod() {
  const cfg = getPastelSettings();
  if (!cfg.fromDate || !cfg.toDate) return [];

  const from = new Date(cfg.fromDate + "T00:00:00");
  const to = new Date(cfg.toDate + "T23:59:59");

  return movements.filter(m => {
    const d = new Date(m.created_at);
    return d >= from && d <= to;
  }).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function pastelDocumentNumber(sale, index) {
  const cfg = getPastelSettings();
  const d = new Date(sale.created_at);
  const datePart = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  return `${cfg.docPrefix}-${datePart}-${String(index + 1).padStart(4, "0")}`;
}

function buildPastelSalesInvoiceRows() {
  const cfg = getPastelSettings();
  const periodSales = salesInPastelPeriod();

  const rows = [[
    "DocumentNo",
    "DocumentDate",
    "CustomerCode",
    "CustomerName",
    "ItemCode",
    "ItemDescription",
    "Quantity",
    "UnitPriceExcl",
    "TaxCode",
    "TaxAmount",
    "LineTotalIncl",
    "SalesAccount",
    "Reference"
  ]];

  periodSales.forEach((s, index) => {
    const qty = Number(s.quantity || 0);
    const revenue = Number(s.revenue || 0);
    const unitPrice = qty ? revenue / qty : 0;

    rows.push([
      pastelDocumentNumber(s, index),
      pastelDate(s.created_at),
      cfg.customerCode,
      "Cash Customer",
      s.product_id || s.product_name,
      s.product_name,
      qty,
      unitPrice.toFixed(2),
      cfg.taxCode,
      "0.00",
      revenue.toFixed(2),
      cfg.salesAccount,
      "Liquor Republic POS sale"
    ]);
  });

  return rows;
}

function buildPastelDailyJournalRows() {
  const cfg = getPastelSettings();
  const periodSales = salesInPastelPeriod();
  const revenue = periodSales.reduce((sum, s) => sum + Number(s.revenue || 0), 0);
  const productCost = periodSales.reduce((sum, s) => sum + Number(s.product_cost || 0), 0);
  const grossProfit = periodSales.reduce((sum, s) => sum + Number(s.gross_profit || 0), 0);
  const reference = `${cfg.docPrefix}-${cfg.fromDate}-TO-${cfg.toDate}`;

  return [[
    "JournalDate",
    "Reference",
    "Account",
    "Description",
    "Debit",
    "Credit",
    "TaxCode"
  ], [
    pastelDate(cfg.toDate),
    reference,
    "1000/000",
    "Cash / Bank control - Liquor Republic POS sales",
    revenue.toFixed(2),
    "0.00",
    cfg.taxCode
  ], [
    pastelDate(cfg.toDate),
    reference,
    cfg.salesAccount,
    "Sales revenue - Liquor Republic POS",
    "0.00",
    revenue.toFixed(2),
    cfg.taxCode
  ], [
    pastelDate(cfg.toDate),
    reference,
    "5000/000",
    "Cost of sales - Liquor Republic POS",
    productCost.toFixed(2),
    "0.00",
    "0"
  ], [
    pastelDate(cfg.toDate),
    reference,
    "1300/000",
    "Inventory control - Liquor Republic POS",
    "0.00",
    productCost.toFixed(2),
    "0"
  ], [
    pastelDate(cfg.toDate),
    reference,
    "9999/000",
    `Gross profit memo: ${grossProfit.toFixed(2)}`,
    "0.00",
    "0.00",
    "0"
  ]];
}

function buildPastelProductsRows() {
  const rows = [[
    "ItemCode",
    "Description",
    "CostPrice",
    "SellingPrice",
    "QuantityOnHand",
    "ReorderLevel",
    "SalesAccount",
    "InventoryAccount"
  ]];

  products.forEach(p => {
    rows.push([
      p.id || p.name,
      p.name,
      Number(p.cost_price || 0).toFixed(2),
      Number(p.selling_price || 0).toFixed(2),
      Number(p.quantity || 0),
      Number(p.alert_level || 0),
      getPastelSettings().salesAccount,
      "1300/000"
    ]);
  });

  return rows;
}

function buildPastelStockMovementRows() {
  const rows = [[
    "MovementDate",
    "MovementType",
    "ItemCode",
    "ItemDescription",
    "QuantityChange",
    "Reason",
    "Reference"
  ]];

  movementsInPastelPeriod().forEach(m => {
    rows.push([
      pastelDate(m.created_at),
      m.movement_type,
      m.product_id || m.product_name,
      m.product_name,
      Number(m.quantity_change || 0),
      m.reason || "",
      "Liquor Republic POS stock movement"
    ]);
  });

  return rows;
}

function validatePastelExport() {
  setDefaultPastelDates();
  const cfg = getPastelSettings();
  if (!cfg.fromDate || !cfg.toDate) {
    showMessage("pastelMessage", "Select export dates first.", "error");
    return false;
  }
  if (new Date(cfg.fromDate) > new Date(cfg.toDate)) {
    showMessage("pastelMessage", "From Date cannot be after To Date.", "error");
    return false;
  }
  return true;
}

function pastelFileName(type) {
  const cfg = getPastelSettings();
  return `liquor-republic-pastel-${type}-${cfg.fromDate}-to-${cfg.toDate}.csv`;
}

function exportPastelSalesInvoices() {
  if (!validatePastelExport()) return;
  downloadCsv(pastelFileName("sales-invoices"), buildPastelSalesInvoiceRows());
  showMessage("pastelMessage", "Sales invoice CSV exported for Sage Pastel.");
}

function exportPastelDailyJournal() {
  if (!validatePastelExport()) return;
  downloadCsv(pastelFileName("daily-journal"), buildPastelDailyJournalRows());
  showMessage("pastelMessage", "Daily journal CSV exported for Sage Pastel.");
}

function exportPastelProducts() {
  if (!validatePastelExport()) return;
  downloadCsv(pastelFileName("inventory-items"), buildPastelProductsRows());
  showMessage("pastelMessage", "Inventory items CSV exported for Sage Pastel.");
}

function exportPastelStockMovements() {
  if (!validatePastelExport()) return;
  downloadCsv(pastelFileName("stock-movements"), buildPastelStockMovementRows());
  showMessage("pastelMessage", "Stock movement CSV exported for Sage Pastel.");
}

function exportPastelBundle() {
  if (!validatePastelExport()) return;
  exportPastelSalesInvoices();
  setTimeout(exportPastelDailyJournal, 250);
  setTimeout(exportPastelProducts, 500);
  setTimeout(exportPastelStockMovements, 750);
}

function updatePastelPreview() {
  const countEl = document.getElementById("pastelSalesCount");
  if (!countEl) return;

  setDefaultPastelDates();
  const periodSales = salesInPastelPeriod();
  const periodMovements = movementsInPastelPeriod();
  const revenue = periodSales.reduce((sum, s) => sum + Number(s.revenue || 0), 0);

  document.getElementById("pastelSalesCount").textContent = periodSales.length;
  document.getElementById("pastelRevenue").textContent = money(revenue);
  document.getElementById("pastelProductCount").textContent = products.length;
  document.getElementById("pastelMovementCount").textContent = periodMovements.length;

  const table = document.getElementById("pastelPreviewTable");
  if (!table) return;

  table.innerHTML = "";
  periodSales.slice(0, 50).forEach((s, index) => {
    table.innerHTML += `
      <tr>
        <td>${new Date(s.created_at).toLocaleString()}</td>
        <td>${pastelDocumentNumber(s, index)}</td>
        <td>${getPastelSettings().customerCode}</td>
        <td>${s.product_name}</td>
        <td>${s.quantity}</td>
        <td>${money(s.revenue)}</td>
      </tr>
    `;
  });

  if (!table.innerHTML) {
    table.innerHTML = `<tr><td colspan="6">No sales found for the selected period.</td></tr>`;
  }
}

document.addEventListener("change", event => {
  if (event.target && event.target.id && event.target.id.startsWith("pastel")) {
    updatePastelPreview();
  }
});

document.addEventListener("input", event => {
  if (event.target && event.target.id && event.target.id.startsWith("pastel")) {
    updatePastelPreview();
  }
});


async function init() {
  const { data } = await supabaseClient.auth.getSession();

  if (data.session) {
    currentUser = data.session.user;
    await loadProfile();
    await loadAll();
    render();
  }
}

init();

/* =========================
   2026-06 Cashup, Rates, Compact Sales UI Update
   ========================= */
let cashierCashupSummary = null;
let supervisorCashupSummary = null;
let lastReportPeriod = null;

function currencyPrefix(currency) {
  const c = String(currency || "USD").toUpperCase();
  if (c === "ZWG") return "ZWG ";
  if (c === "ZAR") return "R";
  return "$";
}

function formatCurrency(value, currency = "USD") {
  return currencyPrefix(currency) + Number(value || 0).toFixed(2);
}

function currencySymbol() {
  return currencyPrefix(document.getElementById("saleCurrency")?.value || "USD");
}

function moneyForSale(value) {
  return formatCurrency(value, document.getElementById("saleCurrency")?.value || "USD");
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function todayKey(date = new Date()) {
  return ymd(date);
}

function todaySalesOnly(list = sales) {
  const today = new Date().toDateString();
  return list.filter(s => new Date(s.created_at).toDateString() === today);
}

async function loadSettings() {
  settings = { usd_rate: 1, usd_zar: 1, usd_zwg: 1 };

  const { data, error } = await supabaseClient
    .from("settings")
    .select("*")
    .in("setting_key", ["currency_usd", "currency_usd_zar", "currency_usd_zwg"]);

  if (error) {
    console.warn("Could not load settings:", error.message);
    return;
  }

  (data || []).forEach(row => {
    if (row.setting_key === "currency_usd") settings.usd_rate = Number(row.setting_value || 1);
    if (row.setting_key === "currency_usd_zar") settings.usd_zar = Number(row.setting_value || 1);
    if (row.setting_key === "currency_usd_zwg") settings.usd_zwg = Number(row.setting_value || 1);
  });

  if (!settings.usd_rate) settings.usd_rate = 1;
}

async function loadSales() {
  const { data, error } = await supabaseClient
    .from("sales")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);

  if (!error) sales = data || [];
}

function onProductNameInput() {
  const name = document.getElementById("productName")?.value.trim().toLowerCase();
  if (!name) return;
  const product = products.find(p => String(p.name || "").trim().toLowerCase() === name);
  if (!product) return;

  const cost = document.getElementById("costPrice");
  const selling = document.getElementById("sellingPrice");
  const alert = document.getElementById("alertLevel");
  if (cost) cost.value = Number(product.cost_price || 0).toFixed(2);
  if (selling) selling.value = Number(product.selling_price || 0).toFixed(2);
  if (alert) alert.value = Number(product.alert_level || 5);
}

function onPriceProductChange() {
  const product = getProductById(document.getElementById("priceProduct")?.value);
  if (!product) return;
  const cost = document.getElementById("newCostPrice");
  const selling = document.getElementById("newSellingPrice");
  if (cost) cost.value = Number(product.cost_price || 0).toFixed(2);
  if (selling) selling.value = Number(product.selling_price || 0).toFixed(2);
}

async function requireSupervisorPassword(messageId = "settingsMessage") {
  if (!isSupervisor()) {
    showMessage(messageId, "Only a supervisor can make this change.", "error");
    return false;
  }

  const password = window.prompt("Supervisor confirmation required. Enter your supervisor password:");
  if (!password) {
    showMessage(messageId, "Supervisor confirmation cancelled.", "error");
    return false;
  }

  const { error } = await supabaseClient.auth.signInWithPassword({
    email: currentUser.email,
    password
  });

  if (error) {
    showMessage(messageId, "Supervisor password is incorrect.", "error");
    return false;
  }

  return true;
}

async function changeProductPrice() {
  if (!(await requireSupervisorPassword("priceSettingsMessage"))) return;

  const productId = document.getElementById("priceProduct")?.value;
  const cost = safeNumber(document.getElementById("newCostPrice")?.value, -1);
  const selling = safeNumber(document.getElementById("newSellingPrice")?.value, -1);

  if (!productId || cost < 0 || selling < 0) {
    showMessage("priceSettingsMessage", "Select product and enter valid cost and selling prices.", "error");
    return;
  }

  const { error } = await supabaseClient.rpc("update_product_price_rpc", {
    p_product_id: productId,
    p_cost_price: cost,
    p_selling_price: selling
  });

  if (error) {
    showMessage("priceSettingsMessage", error.message, "error");
    return;
  }

  await loadAll();
  render();
  showMessage("priceSettingsMessage", "Product price updated successfully.");
}

async function updateRates() {
  if (!(await requireSupervisorPassword("rateSettingsMessage"))) return;

  const zar = safeNumber(document.getElementById("usdZarRate")?.value, 0);
  const zwg = safeNumber(document.getElementById("usdZwgRate")?.value, 0);

  if (zar <= 0 || zwg <= 0) {
    showMessage("rateSettingsMessage", "Enter valid USD:ZAR and USD:ZWG rates.", "error");
    return;
  }

  const { error } = await supabaseClient.rpc("upsert_currency_rates_rpc", {
    p_usd_zar: zar,
    p_usd_zwg: zwg
  });

  if (error) {
    showMessage("rateSettingsMessage", error.message, "error");
    return;
  }

  settings.usd_rate = 1;
  settings.usd_zar = zar;
  settings.usd_zwg = zwg;
  showMessage("rateSettingsMessage", "Exchange rates updated successfully.");
}

function calculateReport(period) {
  const periodSales = getPeriodSales(period);
  const revenue = periodSales.reduce((sum, s) => sum + Number(s.revenue || 0), 0);
  const productCost = periodSales.reduce((sum, s) => sum + Number(s.product_cost || 0), 0);
  const grossProfit = periodSales.reduce((sum, s) => sum + Number(s.gross_profit || 0), 0);
  const netProfit = grossProfit;

  const productTotals = {};
  periodSales.forEach(s => {
    productTotals[s.product_name] = (productTotals[s.product_name] || 0) + Number(s.quantity || 0);
  });

  let topProduct = "No sales yet";
  let highestQty = 0;
  Object.entries(productTotals).forEach(([name, qty]) => {
    if (qty > highestQty) {
      highestQty = qty;
      topProduct = `${name} (${qty} sold)`;
    }
  });

  const averageProfitPerDay =
    period === "daily" ? netProfit :
    period === "weekly" ? netProfit / 7 :
    netProfit / 30;

  return { revenue, productCost, grossProfit, netProfit, averageProfitPerDay, topProduct, numberOfSales: periodSales.length };
}

function showReport(period) {
  lastReportPeriod = period;
  const report = calculateReport(period);

  document.getElementById("report").innerHTML = `
    <h3>${period.charAt(0).toUpperCase() + period.slice(1)} Report</h3>
    <div class="metrics report-metrics">
      <div class="metric">Sales Revenue<strong>${money(report.revenue)}</strong></div>
      <div class="metric">Product Cost<strong>${money(report.productCost)}</strong></div>
      <div class="metric">Gross Profit<strong>${money(report.grossProfit)}</strong></div>
      <div class="metric">Net Profit<strong>${money(report.netProfit)}</strong></div>
      <div class="metric">Average Profit / Day<strong>${money(report.averageProfitPerDay)}</strong></div>
      <div class="metric">Most Sought Product<strong>${report.topProduct}</strong></div>
      <div class="metric">Number of Sales<strong>${report.numberOfSales}</strong></div>
    </div>
  `;
}

function cashupCurrency() {
  return document.getElementById("cashupCurrency")?.value || "USD";
}

function cashupMethodTotalsFromSummary(summary) {
  return {
    cash: Number(summary?.cash || 0),
    pos: Number(summary?.pos || 0),
    ecocash: Number(summary?.ecocash || 0),
    total: Number(summary?.total || 0)
  };
}

async function loadCashierCashupSummary() {
  const currency = cashupCurrency();
  const { data, error } = await supabaseClient.rpc("cashier_cashup_summary_rpc", {
    p_currency: currency
  });

  if (error) {
    cashierCashupSummary = null;
    showMessage("cashupMessage", error.message, "error");
    return;
  }

  cashierCashupSummary = data || {};
}

async function loadSupervisorCashupSummary() {
  if (!isSupervisor()) return;
  const currency = cashupCurrency();
  const { data, error } = await supabaseClient.rpc("supervisor_cashup_summary_rpc", {
    p_currency: currency
  });

  if (error) {
    supervisorCashupSummary = null;
    showMessage("supervisorCashupMessage", error.message, "error");
    return;
  }

  supervisorCashupSummary = data || {};
}

function renderCashierCashupSummary() {
  const currency = cashupCurrency();
  const totals = cashupMethodTotalsFromSummary(cashierCashupSummary);
  const ids = {
    cashierCashTotal: totals.cash,
    cashierPosTotal: totals.pos,
    cashierEcocashTotal: totals.ecocash,
    cashierGrandTotal: totals.total
  };

  Object.entries(ids).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = formatCurrency(value, currency);
  });

  const status = document.getElementById("cashierCashupStatus");
  if (status) {
    status.textContent = totals.total > 0
      ? "Pending cashup for today's unconcluded transactions."
      : "No pending transactions for this currency.";
  }
}

function renderSupervisorCashupSummary() {
  const table = document.getElementById("supervisorCashupTable");
  if (!table || !isSupervisor()) return;

  const currency = cashupCurrency();
  const recorded = supervisorCashupSummary?.recorded_cashups || [];
  const pending = supervisorCashupSummary?.pending_cashiers || [];
  table.innerHTML = "";

  recorded.forEach(row => {
    table.innerHTML += `
      <tr>
        <td>${row.cashier_name || row.cashier_id || "Cashier"}</td>
        <td>Recorded</td>
        <td>${formatCurrency(row.system_cash || 0, currency)}</td>
        <td>${formatCurrency(row.system_pos || 0, currency)}</td>
        <td>${formatCurrency(row.system_ecocash || 0, currency)}</td>
        <td>${formatCurrency(row.total_amount || 0, currency)}</td>
        <td>${formatCurrency(row.difference || 0, currency)}</td>
        <td><button class="small-btn" onclick="concludeCashup('${row.id}')">Conclude</button></td>
      </tr>
    `;
  });

  pending.forEach(row => {
    table.innerHTML += `
      <tr>
        <td>${row.cashier_name || row.cashier_id || "Cashier"}</td>
        <td>Waiting for cashier cashup</td>
        <td>${formatCurrency(row.cash || 0, currency)}</td>
        <td>${formatCurrency(row.pos || 0, currency)}</td>
        <td>${formatCurrency(row.ecocash || 0, currency)}</td>
        <td>${formatCurrency(row.total || 0, currency)}</td>
        <td class="muted">—</td>
        <td class="muted">Not recorded yet</td>
      </tr>
    `;
  });

  if (!table.innerHTML) {
    table.innerHTML = `<tr><td colspan="8">No pending or recorded cashups for ${currency}. Once concluded, cashups disappear until new sales are made.</td></tr>`;
  }
}

async function refreshCashupReports() {
  await loadCashierCashupSummary();
  if (isSupervisor()) await loadSupervisorCashupSummary();
  renderCashierCashupSummary();
  renderSupervisorCashupSummary();
}

async function recordCashup() {
  const currency = cashupCurrency();
  const cash = safeNumber(document.getElementById("actualCashAmount")?.value, 0);
  const pos = safeNumber(document.getElementById("actualPosAmount")?.value, 0);
  const ecocash = safeNumber(document.getElementById("actualEcocashAmount")?.value, 0);

  const { data, error } = await supabaseClient.rpc("record_cashup_rpc", {
    p_currency: currency,
    p_cash_amount: cash,
    p_pos_amount: pos,
    p_ecocash_amount: ecocash
  });

  if (error) {
    showMessage("cashupMessage", error.message, "error");
    return;
  }

  document.getElementById("actualCashAmount").value = "";
  document.getElementById("actualPosAmount").value = "";
  document.getElementById("actualEcocashAmount").value = "";
  showMessage("cashupMessage", `Cashup recorded successfully for ${currency}. Supervisor can now conclude it.`);
  await loadAll();
  await refreshCashupReports();
}

async function concludeCashup(cashupId) {
  if (!isSupervisor()) return;
  const { error } = await supabaseClient.rpc("conclude_cashup_rpc", {
    p_cashup_id: cashupId
  });

  if (error) {
    showMessage("supervisorCashupMessage", error.message, "error");
    return;
  }

  showMessage("supervisorCashupMessage", "Cashup concluded.");
  await refreshCashupReports();
}

async function concludeAllCashups() {
  if (!isSupervisor()) return;
  const { error } = await supabaseClient.rpc("conclude_all_cashups_rpc", {
    p_currency: cashupCurrency()
  });

  if (error) {
    showMessage("supervisorCashupMessage", error.message, "error");
    return;
  }

  showMessage("supervisorCashupMessage", "All recorded cashups for this currency have been concluded.");
  await refreshCashupReports();
}

async function recordSale() {
  if (!validatePayment()) return;

  const currency = document.getElementById("saleCurrency")?.value || "USD";
  const paymentMethod = document.getElementById("paymentMethod")?.value || "CASH";
  const amountReceived = Number(document.getElementById("amountReceived")?.value || 0);

  const { data, error } = await supabaseClient.rpc("record_invoice_sale_rpc", {
    p_items: receiptItems.map(item => ({ product_id: item.product_id, quantity: item.quantity })),
    p_currency: currency,
    p_payment_method: paymentMethod,
    p_amount_received: amountReceived
  });

  if (error) {
    showMessage("saleMessage", error.message, "error");
    return;
  }

  const result = data || {};
  const total = receiptTotal();
  const change = paymentMethod === "CASH" && amountReceived > total ? amountReceived - total : 0;
  receiptItems = [];
  document.getElementById("amountReceived").value = "";
  renderReceipt();
  await loadAll();

  const saleId = result.sale_id || result.invoice_id || result.id;
  const recordedSale = sales.find(s => String(s.id) === String(saleId)) || sales[0];
  if (recordedSale) {
    await enqueuePastelSync("sale_invoice", "sales", recordedSale.id || `${recordedSale.created_at}-${recordedSale.product_id}`, buildPastelSalePayload(recordedSale));
    await loadPastelSyncJobs();
  }

  showMessage("saleMessage", `Sale recorded successfully. ${change > 0 ? `Change: ${currencyPrefix(currency)}${change.toFixed(2)}.` : ""} Queued for ZIMRA and Pastel sync.`);
  render();
  await refreshCashupReports();
}

function fillDropdowns() {
  const ids = ["saleProduct", "deductProduct", "stockTakeProduct", "priceProduct"];

  ids.forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = "";

    if (id === "priceProduct") {
      select.innerHTML = `<option value="">Select product</option>`;
    }

    products.forEach(p => {
      const disabled = (id !== "priceProduct" && Number(p.quantity || 0) <= 0) ? "disabled" : "";
      select.innerHTML += `<option value="${p.id}" ${disabled}>${p.name} — ${p.quantity} left — ${money(p.selling_price)}</option>`;
    });
  });

  const dataList = document.getElementById("productNameList");
  if (dataList) {
    dataList.innerHTML = "";
    products.forEach(p => {
      dataList.innerHTML += `<option value="${p.name}"></option>`;
    });
  }

  if (document.getElementById("saleProduct")) onSaleProductChange();
  if (document.getElementById("priceProduct")) onPriceProductChange();
  renderReceipt();
}

function render() {
  if (!currentUser || !currentProfile) return;

  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");

  document.getElementById("userInfo").textContent = `${currentProfile.full_name} — ${currentProfile.role}`;

  document.querySelectorAll(".supervisor-only").forEach(el => {
    el.classList.toggle("hidden", !isSupervisor());
  });

  fillDropdowns();

  const productCount = document.getElementById("productCount");
  if (productCount) productCount.textContent = products.length;

  const usdRate = document.getElementById("usdRate");
  const zarRate = document.getElementById("usdZarRate");
  const zwgRate = document.getElementById("usdZwgRate");
  if (usdRate) usdRate.value = "1";
  if (zarRate) zarRate.value = Number(settings.usd_zar || 1);
  if (zwgRate) zwgRate.value = Number(settings.usd_zwg || 1);

  const today = calculateReport("daily");
  const todaySalesEl = document.getElementById("todaySales");
  const todayProfitEl = document.getElementById("todayProfit");
  const topProductEl = document.getElementById("topProduct");
  if (todaySalesEl) todaySalesEl.textContent = money(today.revenue);
  if (todayProfitEl) todayProfitEl.textContent = money(today.netProfit);
  if (topProductEl) topProductEl.textContent = today.topProduct;

  const alerts = document.getElementById("alerts");
  if (alerts) {
    alerts.innerHTML = "";
    products.forEach(p => {
      if (Number(p.quantity) <= Number(p.alert_level)) {
        alerts.innerHTML += `<div class="alert">${p.name} has only ${p.quantity} left. Restock soon.</div>`;
      }
    });
    if (!alerts.innerHTML) alerts.innerHTML = `<div class="good">All products have enough stock.</div>`;
  }

  const stockTable = document.getElementById("stockTable");
  if (stockTable) {
    stockTable.innerHTML = "";
    products.forEach(p => {
      stockTable.innerHTML += `
        <tr>
          <td>${p.name}</td>
          <td>${money(p.cost_price)}</td>
          <td>${money(p.selling_price)}</td>
          <td>${p.quantity}</td>
          <td>${p.alert_level}</td>
        </tr>
      `;
    });
  }

  const salesTable = document.getElementById("salesTable");
  if (salesTable) {
    salesTable.innerHTML = "";
    sales.slice(0, 50).forEach(s => {
      const currency = s.currency || "USD";
      salesTable.innerHTML += `
        <tr>
          <td>${new Date(s.created_at).toLocaleString()}</td>
          <td>${s.receipt_number || s.invoice_number || ""}</td>
          <td>${s.product_name || "Sale"}</td>
          <td>${s.quantity || ""}</td>
          <td>${currency}</td>
          <td>${s.payment_method || ""}</td>
          <td>${formatCurrency(s.revenue || 0, currency)}</td>
          <td>${formatCurrency(s.gross_profit || 0, currency)}</td>
        </tr>
      `;
    });
  }

  const movementTable = document.getElementById("movementTable");
  if (movementTable) {
    movementTable.innerHTML = "";
    movements.slice(0, 50).forEach(m => {
      movementTable.innerHTML += `
        <tr>
          <td>${new Date(m.created_at).toLocaleString()}</td>
          <td>${m.movement_type}</td>
          <td>${m.product_name}</td>
          <td>${m.quantity_change}</td>
          <td>${m.reason || ""}</td>
        </tr>
      `;
    });
  }

  renderReceipt();
  renderPastelSyncStatus();
  updatePastelPreview();
  if (lastReportPeriod) showReport(lastReportPeriod);
  refreshCashupReports().catch(err => console.warn("cashup refresh failed", err));
}

function onSaleCurrencyChange() {
  updateReceiptTotals();
  onPaymentMethodChange();
}

/* Currency conversion override: products are priced in USD, ZAR/ZWG totals use supervisor rates. */
function selectedCurrencyRate(currency = document.getElementById("saleCurrency")?.value || "USD") {
  const c = String(currency || "USD").toUpperCase();
  if (c === "ZAR") return Number(settings.usd_zar || 1);
  if (c === "ZWG") return Number(settings.usd_zwg || 1);
  return 1;
}

function receiptTotal() {
  const baseUsd = receiptItems.reduce((sum, item) => sum + Number(item.line_total || 0), 0);
  return Number((baseUsd * selectedCurrencyRate()).toFixed(2));
}

function moneyForSale(value) {
  return formatCurrency(value, document.getElementById("saleCurrency")?.value || "USD");
}

function renderReceipt() {
  const table = document.getElementById("receiptItemsTable");
  if (!table) return;

  const currency = document.getElementById("saleCurrency")?.value || "USD";
  const rate = selectedCurrencyRate(currency);
  table.innerHTML = "";

  receiptItems.forEach(item => {
    table.innerHTML += `
      <tr>
        <td>${item.product_name}</td>
        <td>${item.quantity}</td>
        <td>${formatCurrency(Number(item.unit_price || 0) * rate, currency)}</td>
        <td>${formatCurrency(Number(item.line_total || 0) * rate, currency)}</td>
        <td><button class="danger small-btn" onclick="removeReceiptItem('${item.product_id}')">Remove</button></td>
      </tr>
    `;
  });

  if (!table.innerHTML) {
    table.innerHTML = `<tr><td colspan="5">No products added yet. Select a product above and press Enter or Add.</td></tr>`;
  }

  updateReceiptTotals();
}

function updateReceiptTotals() {
  const total = receiptTotal();
  const itemCount = receiptItemCount();
  const currency = document.getElementById("saleCurrency")?.value || "USD";

  const grandTotal = document.getElementById("receiptGrandTotal");
  const receiptCount = document.getElementById("receiptItemCount");
  const paymentTotal = document.getElementById("paymentTotal");

  if (grandTotal) grandTotal.textContent = formatCurrency(total, currency);
  if (receiptCount) receiptCount.textContent = itemCount;
  if (paymentTotal) paymentTotal.textContent = formatCurrency(total, currency);

  updatePaymentPreview();
}

function onSaleCurrencyChange() {
  renderReceipt();
  onPaymentMethodChange();
}

/* =========================
   Requested POS controls update
   ========================= */
let lastMovementPeriod = "daily";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function logout() {
  receiptItems = [];
  try { sessionStorage.removeItem("liquor_republic_pending_receipt"); } catch (_) {}
  const amount = document.getElementById("amountReceived");
  if (amount) amount.value = "";
  await supabaseClient.auth.signOut();
  currentUser = null;
  currentProfile = null;
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
}

function selectedPaymentMethod() {
  return document.getElementById("paymentMethod")?.value || "CASH";
}

function methodLabel(method) {
  const m = String(method || "CASH").toUpperCase();
  if (m === "POS_ECOCASH" || m === "POS" || m === "SWIPE" || m === "ECOCASH") return "POS (Swipe / EcoCash)";
  return "CASH";
}

function onPaymentMethodChange() {
  const method = selectedPaymentMethod();
  const amountInput = document.getElementById("amountReceived");
  if (amountInput && method !== "CASH") amountInput.value = receiptTotal().toFixed(2);
  updatePaymentPreview();
}

function onSaleCurrencyChange() {
  const currency = document.getElementById("saleCurrency")?.value || "USD";
  const methodSelect = document.getElementById("paymentMethod");
  if (methodSelect) {
    if (currency === "ZAR") {
      methodSelect.value = "CASH";
      methodSelect.disabled = true;
      showMessage("saleMessage", "ZAR transactions are cash only.");
    } else {
      methodSelect.disabled = false;
    }
  }
  renderReceipt();
  onPaymentMethodChange();
}

function updatePaymentPreview() {
  const total = receiptTotal();
  const amount = Number(document.getElementById("amountReceived")?.value || 0);
  const method = selectedPaymentMethod();
  const currency = document.getElementById("saleCurrency")?.value || "USD";
  const change = method === "CASH" && amount > total ? amount - total : 0;
  const amountEl = document.getElementById("paymentAmountReceived");
  const changeEl = document.getElementById("paymentChange");
  const totalEl = document.getElementById("paymentTotal");
  if (totalEl) totalEl.textContent = formatCurrency(total, currency);
  if (amountEl) amountEl.textContent = formatCurrency(amount, currency);
  if (changeEl) changeEl.textContent = formatCurrency(change, currency);
}

function validatePayment() {
  const total = receiptTotal();
  const amount = Number(document.getElementById("amountReceived")?.value || 0);
  const method = selectedPaymentMethod();
  const currency = document.getElementById("saleCurrency")?.value || "USD";
  if (receiptItems.length === 0) {
    showMessage("saleMessage", "Add at least one product to the receipt first.", "error");
    return false;
  }
  if (currency === "ZAR" && method !== "CASH") {
    showMessage("saleMessage", "ZAR is cash only. POS / EcoCash is disabled for ZAR.", "error");
    return false;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    showMessage("saleMessage", "Enter the amount received.", "error");
    return false;
  }
  if (amount < total) {
    showMessage("saleMessage", "Amount received is less than the total cost of goods.", "error");
    return false;
  }
  if (method !== "CASH" && Number(amount.toFixed(2)) !== Number(total.toFixed(2))) {
    showMessage("saleMessage", "For POS (Swipe / EcoCash), amount received must be exactly equal to the total cost.", "error");
    return false;
  }
  return true;
}

function toggleTransferOptions() {
  const el = document.getElementById("transferOptions");
  if (el) el.classList.toggle("hidden");
}

async function transferCurrentReceipt() {
  if (!receiptItems.length) {
    showMessage("saleMessage", "Add products to the receipt before transferring.", "error");
    return;
  }
  const currency = document.getElementById("saleCurrency")?.value || "USD";
  const transferItems = receiptItems.map(item => ({ ...item }));
  const { data, error } = await supabaseClient.rpc("create_transfer_transaction_rpc", {
    p_items: transferItems.map(item => ({ product_id: item.product_id, quantity: item.quantity })),
    p_currency: currency
  });
  if (error) {
    showMessage("saleMessage", error.message, "error");
    return;
  }
  const code = data?.transfer_code || data?.code;
  receiptItems = [];
  renderReceipt();
  printTransferSlip(code, currency, transferItems);
  showMessage("saleMessage", `Transaction transferred. Code: ${escapeHtml(code)}`);
}

function receiveTransferPrompt() {
  const code = window.prompt("Scan the transfer barcode or enter the transfer number:");
  if (!code) return;
  receiveTransferredReceipt(code.trim());
}

async function receiveTransferredReceipt(code) {
  const { data, error } = await supabaseClient.rpc("receive_transfer_transaction_rpc", { p_transfer_code: code });
  if (error) {
    showMessage("saleMessage", error.message, "error");
    return;
  }
  const transferredItems = data?.items || [];
  const newItems = [];
  for (const line of transferredItems) {
    const product = getProductById(line.product_id);
    if (!product) {
      showMessage("saleMessage", `Product not found for transfer line ${escapeHtml(line.product_name || line.product_id)}.`, "error");
      return;
    }
    const qty = Number(line.quantity || 0);
    if (Number(product.quantity || 0) < qty) {
      showMessage("saleMessage", `${product.name} now has only ${product.quantity} available. Cannot receive transferred invoice.`, "error");
      return;
    }
    newItems.push({
      product_id: product.id,
      product_name: product.name,
      quantity: qty,
      unit_price: Number(product.selling_price || 0),
      cost_price: Number(product.cost_price || 0),
      vat_rate: Number(product.vat_rate || 15),
      line_total: Number((qty * Number(product.selling_price || 0)).toFixed(2))
    });
  }
  receiptItems = newItems;
  const currencySelect = document.getElementById("saleCurrency");
  if (currencySelect && data?.currency) currencySelect.value = data.currency;
  renderReceipt();
  onSaleCurrencyChange();
  showMessage("saleMessage", `Transferred transaction ${escapeHtml(code)} received. Complete payment normally.`);
}

function printTransferSlip(code, currency, items = receiptItems) {
  if (!code) return;
  const rows = items.map(item => `<tr><td>${escapeHtml(item.product_name)}</td><td>${item.quantity}</td></tr>`).join("");
  const win = window.open("", "_blank", "width=420,height=620");
  if (!win) return;
  win.document.write(`
    <html><head><title>Transfer Transaction ${escapeHtml(code)}</title>
    <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
    <style>body{font-family:Arial;padding:18px}h2{text-align:center}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}.code{text-align:center;font-size:20px;font-weight:bold;margin:10px 0}.muted{color:#666;text-align:center}</style>
    </head><body>
      <h2>Liquor Republic</h2>
      <p class="muted">Transfer Transaction</p>
      <div class="code">${escapeHtml(code)}</div>
      <svg id="barcode"></svg>
      <p>Currency: ${escapeHtml(currency || "USD")}</p>
      <table><thead><tr><th>Product</th><th>Qty</th></tr></thead><tbody>${rows || ""}</tbody></table>
      <p class="muted">Another cashier must click Receive Transaction and scan or enter this code.</p>
      <script>try{JsBarcode('#barcode','${escapeHtml(code)}',{format:'CODE128',displayValue:true,width:2,height:70});}catch(e){};setTimeout(()=>{window.print();},500);<\/script>
    </body></html>
  `);
  win.document.close();
}

function onProductNameInput() {
  const select = document.getElementById("productName");
  const selected = select?.value || "__new__";
  const newWrap = document.getElementById("newProductNameWrap");
  const selling = document.getElementById("sellingPrice");
  const alert = document.getElementById("alertLevel");
  if (newWrap) newWrap.classList.toggle("hidden", selected !== "__new__");
  if (selected === "__new__") {
    if (selling) selling.value = "";
    if (alert) alert.value = "5";
    return;
  }
  const product = getProductById(selected);
  if (!product) return;
  if (selling) selling.value = Number(product.selling_price || 0).toFixed(2);
  if (alert) alert.value = Number(product.alert_level || 5);
}

async function receiveStock() {
  if (!isSupervisor()) return;
  const selected = document.getElementById("productName")?.value || "__new__";
  const existingProduct = selected === "__new__" ? null : getProductById(selected);
  const name = existingProduct ? existingProduct.name : document.getElementById("newProductName")?.value.trim();
  const selling = safeNumber(document.getElementById("sellingPrice")?.value, -1);
  const quantity = safeNumber(document.getElementById("quantity")?.value, 0);
  const alertLevel = safeNumber(document.getElementById("alertLevel")?.value, 5);
  if (!name) {
    showMessage("stockMessage", "Enter or select a product name.", "error");
    return;
  }
  if (selling < 0) {
    showMessage("stockMessage", "Enter a valid selling price.", "error");
    return;
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    showMessage("stockMessage", "Quantity received must be a whole number greater than zero.", "error");
    return;
  }
  if (existingProduct && Number(existingProduct.selling_price || 0).toFixed(2) !== Number(selling || 0).toFixed(2)) {
    showMessage("stockMessage", "Selling price has changed. Click Change Price first and confirm with supervisor password.", "error");
    return;
  }
  const cost = existingProduct ? Number(existingProduct.cost_price || 0) : 0;
  const { error } = await supabaseClient.rpc("receive_stock_rpc", {
    p_name: name,
    p_cost_price: cost,
    p_selling_price: selling,
    p_quantity: quantity,
    p_alert_level: alertLevel
  });
  if (error) {
    showMessage("stockMessage", error.message, "error");
    return;
  }
  document.getElementById("newProductName").value = "";
  document.getElementById("quantity").value = "";
  await loadAll();
  const latestMovement = movements[0];
  if (latestMovement) {
    await enqueuePastelSync("stock_movement", "stock_movements", latestMovement.id || `${latestMovement.created_at}-${latestMovement.product_id}`, buildPastelMovementPayload(latestMovement));
    await loadPastelSyncJobs();
  }
  showMessage("stockMessage", "Stock received successfully.");
  render();
}

async function changeReceiveStockPrice() {
  const selected = document.getElementById("productName")?.value;
  const product = getProductById(selected);
  if (!product) {
    showMessage("stockMessage", "Select an existing product before changing price.", "error");
    return;
  }
  const selling = safeNumber(document.getElementById("sellingPrice")?.value, -1);
  if (selling < 0) {
    showMessage("stockMessage", "Enter a valid selling price.", "error");
    return;
  }
  if (!(await requireSupervisorPassword("stockMessage"))) return;
  const { error } = await supabaseClient.rpc("update_product_price_rpc", {
    p_product_id: product.id,
    p_cost_price: Number(product.cost_price || 0),
    p_selling_price: selling
  });
  if (error) {
    showMessage("stockMessage", error.message, "error");
    return;
  }
  await loadAll();
  showMessage("stockMessage", "Selling price changed successfully.");
  render();
}

function onPriceProductChange() {
  const product = getProductById(document.getElementById("priceProduct")?.value);
  const current = document.getElementById("currentSellingPrice");
  const selling = document.getElementById("newSellingPrice");
  if (!product) {
    if (current) current.value = "";
    if (selling) selling.value = "";
    return;
  }
  if (current) current.value = Number(product.selling_price || 0).toFixed(2);
  if (selling) selling.value = Number(product.selling_price || 0).toFixed(2);
}

async function changeProductPrice() {
  if (!(await requireSupervisorPassword("priceSettingsMessage"))) return;
  const productId = document.getElementById("priceProduct")?.value;
  const product = getProductById(productId);
  const selling = safeNumber(document.getElementById("newSellingPrice")?.value, -1);
  if (!product || selling < 0) {
    showMessage("priceSettingsMessage", "Select product and enter a valid selling price.", "error");
    return;
  }
  const { error } = await supabaseClient.rpc("update_product_price_rpc", {
    p_product_id: product.id,
    p_cost_price: Number(product.cost_price || 0),
    p_selling_price: selling
  });
  if (error) {
    showMessage("priceSettingsMessage", error.message, "error");
    return;
  }
  await loadAll();
  render();
  showMessage("priceSettingsMessage", "Product selling price updated successfully.");
}

async function deductStock() {
  if (!(await requireSupervisorPassword("stockMessage"))) return;
  const productId = document.getElementById("deductProduct")?.value;
  const quantity = safeNumber(document.getElementById("deductQuantity")?.value, 0);
  const reason = document.getElementById("deductReason")?.value.trim() || "Manual deduction";
  const { error } = await supabaseClient.rpc("deduct_stock_rpc", { p_product_id: productId, p_quantity: quantity, p_reason: reason });
  if (error) {
    alert(error.message);
    return;
  }
  document.getElementById("deductQuantity").value = "";
  document.getElementById("deductReason").value = "";
  await loadAll();
  render();
}

async function stockTake() {
  if (!(await requireSupervisorPassword("stockMessage"))) return;
  const productId = document.getElementById("stockTakeProduct")?.value;
  const actualQuantity = safeNumber(document.getElementById("stockTakeQuantity")?.value, -1);
  const { error } = await supabaseClient.rpc("stock_take_rpc", { p_product_id: productId, p_actual_quantity: actualQuantity });
  if (error) {
    alert(error.message);
    return;
  }
  document.getElementById("stockTakeQuantity").value = "";
  await loadAll();
  render();
}

async function cancelTransaction() {
  if (!(await requireSupervisorPassword("cancelMessage"))) return;
  const receiptNumber = document.getElementById("cancelReceiptNumber")?.value.trim();
  const reason = document.getElementById("cancelReason")?.value.trim();
  if (!receiptNumber) {
    showMessage("cancelMessage", "Enter the receipt number.", "error");
    return;
  }
  if (!reason || reason.length > 40) {
    showMessage("cancelMessage", "Enter a reason not more than 40 letters.", "error");
    return;
  }
  const { error } = await supabaseClient.rpc("cancel_transaction_rpc", { p_receipt_number: receiptNumber, p_reason: reason });
  if (error) {
    showMessage("cancelMessage", error.message, "error");
    return;
  }
  document.getElementById("cancelReceiptNumber").value = "";
  document.getElementById("cancelReason").value = "";
  await loadAll();
  render();
  showMessage("cancelMessage", "Transaction cancelled and stock restored.");
}

async function loadMovements() {
  const { data, error } = await supabaseClient
    .from("stock_movements")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1000);
  if (!error) movements = data || [];
}

function movementPeriodItems(period = lastMovementPeriod) {
  const now = new Date();
  return movements.filter(m => {
    const d = new Date(m.created_at);
    if (period === "daily") return d.toDateString() === now.toDateString();
    if (period === "weekly") {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(now.getDate() - 7);
      return d >= sevenDaysAgo && d <= now;
    }
    if (period === "monthly") return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    return true;
  });
}

function renderMovementTable(title, rows) {
  const totalQty = rows.reduce((sum, r) => sum + Math.abs(Number(r.quantity_change || 0)), 0);
  const body = rows.map(m => `
    <tr>
      <td>${new Date(m.created_at).toLocaleString()}</td>
      <td>${escapeHtml(m.product_name || "")}</td>
      <td>${m.quantity_change}</td>
      <td>${escapeHtml(m.reason || "")}</td>
    </tr>`).join("") || `<tr><td colspan="4">No records.</td></tr>`;
  return `
    <div class="movement-group">
      <h3>${title} <span class="muted">(${rows.length} records, ${totalQty} items)</span></h3>
      <table><thead><tr><th>Date</th><th>Product</th><th>Qty Change</th><th>Reason</th></tr></thead><tbody>${body}</tbody></table>
    </div>`;
}

function renderMovementReports(period = "daily") {
  lastMovementPeriod = period;
  const target = document.getElementById("movementGroupedReport");
  if (!target) return;
  const rows = movementPeriodItems(period);
  const added = rows.filter(m => ["RECEIVE", "ADD", "ADDED", "STOCK_IN"].includes(String(m.movement_type || "").toUpperCase()) || Number(m.quantity_change || 0) > 0 && String(m.reason || "").toLowerCase().includes("received"));
  const sold = rows.filter(m => String(m.movement_type || "").toUpperCase() === "SALE" || String(m.reason || "").toLowerCase().includes("receipt sale"));
  const deducted = rows.filter(m => {
    const t = String(m.movement_type || "").toUpperCase();
    return t === "DEDUCT" || t === "STOCK_TAKE" || (Number(m.quantity_change || 0) < 0 && t !== "SALE");
  });
  target.innerHTML = `
    <h2>${period.charAt(0).toUpperCase() + period.slice(1)} Stock Movement Report</h2>
    ${renderMovementTable("Stock Added", added)}
    ${renderMovementTable("Stock Deducted / Adjusted", deducted)}
    ${renderMovementTable("Stock Sold", sold)}
  `;
}

function getPeriodSales(period) {
  const now = new Date();
  return sales.filter(s => {
    if (s.canceled_at || s.status === "cancelled") return false;
    const d = new Date(s.created_at);
    if (period === "daily") return d.toDateString() === now.toDateString();
    if (period === "weekly") {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(now.getDate() - 7);
      return d >= sevenDaysAgo && d <= now;
    }
    if (period === "monthly") return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    return false;
  });
}

function calculateReport(period) {
  const periodSales = getPeriodSales(period);
  const revenue = periodSales.reduce((sum, s) => sum + Number(s.revenue || 0), 0);
  const productTotals = {};
  periodSales.forEach(s => { productTotals[s.product_name] = (productTotals[s.product_name] || 0) + Number(s.quantity || 0); });
  let topProduct = "No sales yet";
  let highestQty = 0;
  Object.entries(productTotals).forEach(([name, qty]) => {
    if (qty > highestQty) { highestQty = qty; topProduct = `${name} (${qty} sold)`; }
  });
  return { revenue, topProduct, numberOfSales: periodSales.length };
}

function showReport(period) {
  if (!isSupervisor()) return;
  lastReportPeriod = period;
  const report = calculateReport(period);
  const el = document.getElementById("report");
  if (!el) return;
  el.innerHTML = `
    <h3>${period.charAt(0).toUpperCase() + period.slice(1)} Report</h3>
    <div class="metrics report-metrics">
      <div class="metric">Sales Revenue<strong>${money(report.revenue)}</strong></div>
      <div class="metric">Most Sought Products<strong>${escapeHtml(report.topProduct)}</strong></div>
      <div class="metric">Number of Sales<strong>${report.numberOfSales}</strong></div>
    </div>`;
}

function cashupMethodTotalsFromSummary(summary) {
  const cash = Number(summary?.cash || 0);
  const pos = Number(summary?.pos || 0) + Number(summary?.ecocash || 0);
  return { cash, pos, ecocash: 0, total: cash + pos };
}

function applyCashupCurrencyRules() {
  const currency = cashupCurrency();
  const posLabel = document.getElementById("actualPosLabel");
  const posInput = document.getElementById("actualPosAmount");
  const cashOnly = currency === "ZAR";
  if (posLabel) posLabel.classList.toggle("hidden", cashOnly);
  if (posInput) {
    posInput.disabled = cashOnly;
    if (cashOnly) posInput.value = "0";
  }
  const status = document.getElementById("cashierCashupStatus");
  if (status && cashOnly) status.innerHTML = `<span class="cash-only-note">ZAR cashup is cash only because ZAR swipe / EcoCash is not accepted.</span>`;
}

function renderCashierCashupSummary() {
  const currency = cashupCurrency();
  const totals = cashupMethodTotalsFromSummary(cashierCashupSummary);
  const cashEl = document.getElementById("cashierCashTotal");
  const posEl = document.getElementById("cashierPosTotal");
  const ecoEl = document.getElementById("cashierEcocashTotal");
  const totalEl = document.getElementById("cashierGrandTotal");
  if (cashEl) cashEl.textContent = formatCurrency(totals.cash, currency);
  if (posEl) posEl.textContent = formatCurrency(currency === "ZAR" ? 0 : totals.pos, currency);
  if (ecoEl) ecoEl.textContent = formatCurrency(0, currency);
  if (totalEl) totalEl.textContent = formatCurrency(currency === "ZAR" ? totals.cash : totals.total, currency);
  const status = document.getElementById("cashierCashupStatus");
  if (status) {
    status.textContent = (currency === "ZAR" ? totals.cash : totals.total) > 0 ? "Pending cashup for today's unconcluded transactions." : "No pending transactions for this currency.";
  }
  applyCashupCurrencyRules();
}

function renderSupervisorCashupSummary() {
  const table = document.getElementById("supervisorCashupTable");
  if (!table || !isSupervisor()) return;
  const currency = cashupCurrency();
  const recorded = supervisorCashupSummary?.recorded_cashups || [];
  const pending = supervisorCashupSummary?.pending_cashiers || [];
  table.innerHTML = "";
  recorded.forEach(row => {
    const pos = currency === "ZAR" ? 0 : Number(row.system_pos || 0) + Number(row.system_ecocash || 0);
    const isOwn = String(row.cashier_id || "") === String(currentUser?.id || "");
    table.innerHTML += `
      <tr>
        <td>${escapeHtml(row.cashier_name || row.cashier_id || "Cashier")}</td>
        <td>Recorded</td>
        <td>${formatCurrency(row.system_cash || 0, currency)}</td>
        <td>${formatCurrency(pos, currency)}</td>
        <td>${formatCurrency((currency === "ZAR" ? Number(row.system_cash || 0) : Number(row.total_amount || 0)), currency)}</td>
        <td>${formatCurrency(row.difference || 0, currency)}</td>
        <td>${isOwn ? '<span class="muted">Needs another supervisor</span>' : `<button class="small-btn" onclick="concludeCashup('${row.id}')">Conclude & Print</button>`}</td>
      </tr>`;
  });
  pending.forEach(row => {
    const pos = currency === "ZAR" ? 0 : Number(row.pos || 0) + Number(row.ecocash || 0);
    table.innerHTML += `
      <tr>
        <td>${escapeHtml(row.cashier_name || row.cashier_id || "Cashier")}</td>
        <td>Waiting for cashier cashup</td>
        <td>${formatCurrency(row.cash || 0, currency)}</td>
        <td>${formatCurrency(pos, currency)}</td>
        <td>${formatCurrency(currency === "ZAR" ? Number(row.cash || 0) : Number(row.total || 0), currency)}</td>
        <td class="muted">—</td>
        <td class="muted">Not recorded yet</td>
      </tr>`;
  });
  if (!table.innerHTML) table.innerHTML = `<tr><td colspan="7">No pending or recorded cashups for ${currency}. Once concluded, cashups disappear until new sales are made.</td></tr>`;
}

async function refreshCashupReports() {
  applyCashupCurrencyRules();
  await loadCashierCashupSummary();
  if (isSupervisor()) await loadSupervisorCashupSummary();
  renderCashierCashupSummary();
  renderSupervisorCashupSummary();
}

async function recordCashup() {
  const currency = cashupCurrency();
  const cash = safeNumber(document.getElementById("actualCashAmount")?.value, 0);
  const pos = currency === "ZAR" ? 0 : safeNumber(document.getElementById("actualPosAmount")?.value, 0);
  const ecocash = 0;
  const { error } = await supabaseClient.rpc("record_cashup_rpc", { p_currency: currency, p_cash_amount: cash, p_pos_amount: pos, p_ecocash_amount: ecocash });
  if (error) {
    showMessage("cashupMessage", error.message, "error");
    return;
  }
  document.getElementById("actualCashAmount").value = "";
  document.getElementById("actualPosAmount").value = "";
  const eco = document.getElementById("actualEcocashAmount");
  if (eco) eco.value = "";
  showMessage("cashupMessage", `Cashup recorded successfully for ${currency}. Supervisor can now conclude it.`);
  await loadAll();
  await refreshCashupReports();
}

async function concludeCashup(cashupId) {
  if (!isSupervisor()) return;
  const { data, error } = await supabaseClient.rpc("conclude_cashup_rpc", { p_cashup_id: cashupId });
  if (error) {
    showMessage("supervisorCashupMessage", error.message, "error");
    return;
  }
  showMessage("supervisorCashupMessage", "Cashup concluded.");
  if (data?.printout) printCashupReport(data.printout);
  await loadAll();
  await refreshCashupReports();
}

async function concludeAllCashups() {
  if (!isSupervisor()) return;
  const { data, error } = await supabaseClient.rpc("conclude_all_cashups_rpc", { p_currency: cashupCurrency() });
  if (error) {
    showMessage("supervisorCashupMessage", error.message, "error");
    return;
  }
  showMessage("supervisorCashupMessage", `${data?.concluded_count || 0} cashup(s) concluded.`);
  if (Array.isArray(data?.printouts) && data.printouts.length) printCashupReport({ batch: true, printouts: data.printouts, currency: cashupCurrency() });
  await loadAll();
  await refreshCashupReports();
}

function printCashupReport(printout) {
  const reports = printout.batch ? printout.printouts : [printout];
  const sections = reports.map(r => {
    const currency = r.currency || "USD";
    const productRows = (r.products || []).map(p => `<tr><td>${escapeHtml(p.product_name)}</td><td>${p.quantity}</td><td>${formatCurrency(p.total || 0, currency)}</td></tr>`).join("") || `<tr><td colspan="3">No product lines.</td></tr>`;
    return `<section style="page-break-after:always">
      <h2>Liquor Republic Cashup Report</h2>
      <p><strong>Cashier:</strong> ${escapeHtml(r.cashier_name || "")}</p>
      <p><strong>Date:</strong> ${escapeHtml(r.cashup_date || todayKey())} | <strong>Currency:</strong> ${escapeHtml(currency)}</p>
      <h3>Money Collected</h3>
      <table><tr><th>Payment Method</th><th>Amount</th></tr>
      <tr><td>Cash</td><td>${formatCurrency(r.system_cash || 0, currency)}</td></tr>
      <tr><td>POS (Swipe / EcoCash)</td><td>${formatCurrency(r.system_pos || 0, currency)}</td></tr>
      <tr><td>Total</td><td>${formatCurrency(r.total_amount || 0, currency)}</td></tr></table>
      <h3>Products Sold</h3>
      <table><thead><tr><th>Product</th><th>Qty</th><th>Total</th></tr></thead><tbody>${productRows}</tbody></table>
      <p><strong>Concluded by:</strong> ${escapeHtml(currentProfile?.full_name || currentUser?.email || "Supervisor")}</p>
    </section>`;
  }).join("");
  const win = window.open("", "_blank", "width=820,height=900");
  if (!win) return;
  win.document.write(`<html><head><title>Cashup Printout</title><style>body{font-family:Arial;padding:20px}h2{color:#11385c}table{width:100%;border-collapse:collapse;margin-bottom:18px}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f3f4f6}@media print{section{page-break-after:always}}</style></head><body>${sections}<script>setTimeout(()=>window.print(),400);<\/script></body></html>`);
  win.document.close();
}

function fillDropdowns() {
  const ids = ["saleProduct", "deductProduct", "stockTakeProduct", "priceProduct"];
  ids.forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = "";
    if (id === "priceProduct") select.innerHTML = `<option value="">Select product</option>`;
    products.forEach(p => {
      const disabled = (id !== "priceProduct" && Number(p.quantity || 0) <= 0) ? "disabled" : "";
      select.innerHTML += `<option value="${p.id}" ${disabled}>${escapeHtml(p.name)} — ${p.quantity} left — ${money(p.selling_price)}</option>`;
    });
  });
  const receiveSelect = document.getElementById("productName");
  if (receiveSelect) {
    const currentValue = receiveSelect.value;
    receiveSelect.innerHTML = `<option value="__new__">+ New product</option>`;
    products.forEach(p => { receiveSelect.innerHTML += `<option value="${p.id}">${escapeHtml(p.name)} — ${p.quantity} left — ${money(p.selling_price)}</option>`; });
    if (currentValue && Array.from(receiveSelect.options).some(o => o.value === currentValue)) receiveSelect.value = currentValue;
    onProductNameInput();
  }
  if (document.getElementById("saleProduct")) onSaleProductChange();
  if (document.getElementById("priceProduct")) onPriceProductChange();
  renderReceipt();
}

function render() {
  if (!currentUser || !currentProfile) return;
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("userInfo").textContent = `${currentProfile.full_name} — ${currentProfile.role}`;
  document.querySelectorAll(".supervisor-only").forEach(el => el.classList.toggle("hidden", !isSupervisor()));
  fillDropdowns();
  const productCount = document.getElementById("productCount");
  if (productCount) productCount.textContent = products.length;
  const usdRate = document.getElementById("usdRate");
  const zarRate = document.getElementById("usdZarRate");
  const zwgRate = document.getElementById("usdZwgRate");
  if (usdRate) usdRate.value = "1";
  if (zarRate) zarRate.value = Number(settings.usd_zar || 1);
  if (zwgRate) zwgRate.value = Number(settings.usd_zwg || 1);
  const today = calculateReport("daily");
  const todaySalesEl = document.getElementById("todaySales");
  const todayProfitEl = document.getElementById("todayProfit");
  const topProductEl = document.getElementById("topProduct");
  if (todaySalesEl) todaySalesEl.textContent = money(today.revenue);
  if (todayProfitEl) todayProfitEl.textContent = "Hidden";
  if (topProductEl) topProductEl.textContent = today.topProduct;
  const alerts = document.getElementById("alerts");
  if (alerts) {
    alerts.innerHTML = "";
    products.forEach(p => { if (Number(p.quantity) <= Number(p.alert_level)) alerts.innerHTML += `<div class="alert">${escapeHtml(p.name)} has only ${p.quantity} left. Restock soon.</div>`; });
    if (!alerts.innerHTML) alerts.innerHTML = `<div class="good">All products have enough stock.</div>`;
  }
  const stockTable = document.getElementById("stockTable");
  if (stockTable) {
    stockTable.innerHTML = "";
    products.forEach(p => { stockTable.innerHTML += `<tr><td>${escapeHtml(p.name)}</td><td class="supervisor-only">${money(p.cost_price)}</td><td>${money(p.selling_price)}</td><td>${p.quantity}</td><td>${p.alert_level}</td></tr>`; });
  }
  renderReceipt();
  renderPastelSyncStatus();
  updatePastelPreview();
  if (lastReportPeriod && isSupervisor()) showReport(lastReportPeriod);
  renderMovementReports(lastMovementPeriod);
  refreshCashupReports().catch(err => console.warn("cashup refresh failed", err));
}

/* =========================
   2026-06-26 Help & Updates + cashier workflow final overrides
   ========================= */
function clearLoginCredentials() {
  const email = document.getElementById("email");
  const password = document.getElementById("password");
  if (email) {
    email.value = "";
    email.setAttribute("autocomplete", "off");
    email.setAttribute("data-lpignore", "true");
  }
  if (password) {
    password.value = "";
    password.setAttribute("autocomplete", "new-password");
    password.setAttribute("data-lpignore", "true");
  }
}


function clearLoginCredentialsIfIdle() {
  const activeId = document.activeElement?.id || "";
  if (activeId === "email" || activeId === "password") return;
  clearLoginCredentials();
}

const login_before_help_update_20260626 = login;
login = async function () {
  receiptItems = [];
  await login_before_help_update_20260626();
  if (currentUser && currentProfile && !isSupervisor()) {
    openPanel("salesPanel");
  }
};

logout = async function () {
  receiptItems = [];
  try { sessionStorage.removeItem("liquor_republic_pending_receipt"); } catch (_) {}
  const amount = document.getElementById("amountReceived");
  if (amount) amount.value = "";
  renderReceipt();
  await supabaseClient.auth.signOut();
  currentUser = null;
  currentProfile = null;
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
  clearLoginCredentials();
  setTimeout(clearLoginCredentialsIfIdle, 150);
  setTimeout(clearLoginCredentialsIfIdle, 700);
};

addProductToReceipt = function () {
  const productId = document.getElementById("saleProduct").value;
  const quantity = Number(document.getElementById("saleQuantity").value || 1);
  const product = getProductById(productId);

  if (!product) {
    showMessage("saleMessage", "Select a product first.", "error");
    return;
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    showMessage("saleMessage", "Enter a valid quantity.", "error");
    return;
  }
  if (!Number.isInteger(quantity)) {
    showMessage("saleMessage", "Quantity must be a whole number.", "error");
    return;
  }

  const existing = receiptItems.find(item => String(item.product_id) === String(product.id));
  const currentReceiptQty = existing ? Number(existing.quantity || 0) : 0;
  const requestedTotalQty = currentReceiptQty + quantity;
  const stockAvailable = Number(product.quantity || 0);

  if (requestedTotalQty > stockAvailable) {
    showMessage("saleMessage", `Insufficient stock. ${escapeHtml(product.name)} has only ${stockAvailable} available.`, "error");
    return;
  }

  if (existing) {
    existing.quantity = requestedTotalQty;
    existing.line_total = Number((existing.quantity * existing.unit_price).toFixed(2));
  } else {
    receiptItems.push({
      product_id: product.id,
      product_name: product.name,
      quantity,
      unit_price: Number(product.selling_price || 0),
      cost_price: Number(product.cost_price || 0),
      vat_rate: Number(product.vat_rate || 15),
      line_total: Number((quantity * Number(product.selling_price || 0)).toFixed(2))
    });
  }

  document.getElementById("saleQuantity").value = "1";
  const msg = document.getElementById("saleMessage");
  if (msg) msg.innerHTML = "";
  renderReceipt();
};

function removeReceiptQty(productId) {
  const item = receiptItems.find(line => String(line.product_id) === String(productId));
  if (!item) return;
  const inputId = `removeQty_${String(productId).replaceAll("-", "_")}`;
  const qty = Number(document.getElementById(inputId)?.value || 1);
  if (!Number.isInteger(qty) || qty <= 0) {
    showMessage("saleMessage", "Enter a valid quantity to remove.", "error");
    return;
  }
  if (qty >= Number(item.quantity || 0)) {
    receiptItems = receiptItems.filter(line => String(line.product_id) !== String(productId));
  } else {
    item.quantity = Number(item.quantity || 0) - qty;
    item.line_total = Number((item.quantity * item.unit_price).toFixed(2));
  }
  renderReceipt();
}

renderReceipt = function () {
  const table = document.getElementById("receiptItemsTable");
  if (!table) return;
  const currency = document.getElementById("saleCurrency")?.value || "USD";
  const rate = selectedCurrencyRate(currency);
  table.innerHTML = "";

  receiptItems.forEach(item => {
    const safeId = String(item.product_id).replaceAll("-", "_");
    table.innerHTML += `
      <tr>
        <td>${escapeHtml(item.product_name)}</td>
        <td>${item.quantity}</td>
        <td>${formatCurrency(Number(item.unit_price || 0) * rate, currency)}</td>
        <td>${formatCurrency(Number(item.line_total || 0) * rate, currency)}</td>
        <td>
          <div class="remove-qty-control">
            <input id="removeQty_${safeId}" type="number" min="1" max="${Number(item.quantity || 1)}" step="1" value="1" title="Quantity to remove" />
            <button class="danger small-btn" onclick="removeReceiptQty('${item.product_id}')">Remove Qty</button>
          </div>
        </td>
      </tr>
    `;
  });

  if (!table.innerHTML) {
    table.innerHTML = `<tr><td colspan="5">No products added yet. Select a product and press Enter or Add.</td></tr>`;
  }
  updateReceiptTotals();
};

recordSale = async function () {
  if (!validatePayment()) return;

  const currency = document.getElementById("saleCurrency")?.value || "USD";
  const paymentMethod = document.getElementById("paymentMethod")?.value || "CASH";
  const amountReceived = Number(document.getElementById("amountReceived")?.value || 0);

  const { data, error } = await supabaseClient.rpc("record_invoice_sale_rpc", {
    p_items: receiptItems.map(item => ({ product_id: item.product_id, quantity: item.quantity })),
    p_currency: currency,
    p_payment_method: paymentMethod,
    p_amount_received: amountReceived
  });

  if (error) {
    showMessage("saleMessage", error.message, "error");
    return;
  }

  const total = receiptTotal();
  const change = paymentMethod === "CASH" && amountReceived > total ? amountReceived - total : 0;
  const result = data || {};
  receiptItems = [];
  const amountBox = document.getElementById("amountReceived");
  if (amountBox) amountBox.value = "";
  renderReceipt();
  await loadAll();

  const saleId = typeof result === "string" ? result : (result.sale_id || result.invoice_id || result.id);
  const recordedSale = sales.find(s => String(s.id) === String(saleId)) || sales[0];
  if (recordedSale) {
    await enqueuePastelSync("sale_invoice", "sales", recordedSale.id || `${recordedSale.created_at}-${recordedSale.product_id}`, buildPastelSalePayload(recordedSale));
    await loadPastelSyncJobs();
  }

  showMessage("saleMessage", `Transaction successful.${change > 0 ? ` Change: ${currencyPrefix(currency)}${change.toFixed(2)}.` : ""}`);
  render();
  await refreshCashupReports();
};

showReport = function (period) {
  lastReportPeriod = period;
  const report = calculateReport(period);
  const reportEl = document.getElementById("report");
  if (!reportEl) return;
  reportEl.innerHTML = `
    <h3>${period.charAt(0).toUpperCase() + period.slice(1)} Report</h3>
    <div class="metrics report-metrics">
      <div class="metric">Sales Revenue<strong>${money(report.revenue)}</strong></div>
      <div class="metric">Most Sought Products<strong>${escapeHtml(report.topProduct)}</strong></div>
      <div class="metric">Number of Sales<strong>${report.numberOfSales}</strong></div>
    </div>
  `;
};

const render_before_help_update_20260626 = render;
render = function () {
  render_before_help_update_20260626();
  if (!currentUser || !currentProfile) return;

  document.body.dataset.role = isSupervisor() ? "supervisor" : "cashier";
  const dashboardNav = document.getElementById("dashboardNavBtn");
  if (dashboardNav) dashboardNav.classList.toggle("hidden", !isSupervisor());

  const dashboardPanel = document.getElementById("dashboardPanel");
  if (!isSupervisor() && dashboardPanel?.classList.contains("active-panel")) {
    openPanel("salesPanel");
  }

  const todayProfit = document.getElementById("todayProfit");
  if (todayProfit) todayProfit.closest(".metric")?.remove();
  const topProduct = document.getElementById("topProduct");
  if (topProduct) topProduct.closest(".metric")?.remove();

  const stockTable = document.getElementById("stockTable");
  if (stockTable) {
    stockTable.innerHTML = "";
    products.forEach(p => {
      stockTable.innerHTML += `<tr><td>${escapeHtml(p.name)}</td><td>${money(p.selling_price)}</td><td>${p.quantity}</td><td>${p.alert_level}</td></tr>`;
    });
  }

  if (lastReportPeriod && isSupervisor()) showReport(lastReportPeriod);
};

window.addEventListener("load", () => {
  if (!currentUser) {
    clearLoginCredentials();
    setTimeout(clearLoginCredentialsIfIdle, 250);
    setTimeout(clearLoginCredentialsIfIdle, 1000);
  } else {
    render();
  }
});
