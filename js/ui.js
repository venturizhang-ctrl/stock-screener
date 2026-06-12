/**
 * ui.js — 突破信号UI
 */

function showLoading(text, sub) {
    document.getElementById('loadingArea').style.display = 'block';
    document.getElementById('loadingText').textContent = text || '正在扫描...';
    document.getElementById('loadingSub').textContent = sub || '';
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('errorArea').style.display = 'none';
}

function hideLoading() { document.getElementById('loadingArea').style.display = 'none'; }

function showError(msg) {
    document.getElementById('errorArea').style.display = 'block';
    document.getElementById('errorText').textContent = msg;
    hideLoading();
}

function hideError() { document.getElementById('errorArea').style.display = 'none'; }

function updateMarketStatus() {
    var status = getMarketStatus();
    var el = document.getElementById('marketStatus');
    el.textContent = status.text;
    el.className = 'market-status ' + status.cls;
}

function updateLastRefresh(time) {
    document.getElementById('lastRefresh').textContent = time ? '扫描于 ' + time : '尚未扫描';
}

function showResultSection(id, show) {
    document.getElementById(id).style.display = show ? 'block' : 'none';
}

function updateResultCount(id, count) {
    document.getElementById(id).textContent = count;
}

function setRefreshButton(disabled) {
    var btn = document.getElementById('btnRefresh');
    btn.disabled = disabled;
    btn.querySelector('.btn-text').textContent = disabled ? '扫描中...' : '扫描突破';
}

function renderStockList(containerId, stocks) {
    var container = document.getElementById(containerId);
    if (!stocks || stocks.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:20px"><p class="empty-text">无符合条件的突破信号</p><p class="empty-hint">交易时段实时扫描效果最佳</p></div>';
        return;
    }

    var html = '';
    stocks.forEach(function(s) {
        var br = s.breakResult;
        var mktCapYi = s.nmc ? (s.nmc / 100000000).toFixed(0) : '--';

        html += '<div class="stock-card">' +
            '<div class="stock-card-header">' +
                '<div><span class="stock-code">' + s.code + '</span>' +
                '<span class="stock-name">' + s.name + '</span></div>' +
                '<span class="stock-change up">+' + s.change.toFixed(2) + '%</span>' +
            '</div>' +
            '<div class="stock-details">' +
                '<div class="detail-item"><span class="detail-label">现价</span><span class="detail-value">' + s.price.toFixed(2) + '</span></div>' +
                '<div class="detail-item"><span class="detail-label">换手率</span><span class="detail-value">' + s.turnover.toFixed(2) + '%</span></div>' +
                '<div class="detail-item"><span class="detail-label">流通市值</span><span class="detail-value">' + mktCapYi + '亿</span></div>' +
            '</div>' +
            '<div class="breakout-badges">' +
                '<span class="break-badge fire">突破' + (br.breakHigh ? br.breakPct.toFixed(2) : '--') + '%</span>' +
                '<span class="break-badge vol">量比 ' + (br.volRatio ? br.volRatio.toFixed(2) : '--') + '</span>' +
                '<span class="break-badge strong">强势 ' + (br.closePctOfHigh ? (br.closePctOfHigh*100).toFixed(0) : '--') + '%</span>' +
            '</div>' +
        '</div>';
    });
    container.innerHTML = html;
}
