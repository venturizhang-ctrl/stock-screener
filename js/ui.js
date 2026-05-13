/**
 * ui.js — UI渲染模块
 */

function showLoading(text, sub) {
    document.getElementById('loadingArea').style.display = 'block';
    document.getElementById('loadingText').textContent = text || '正在获取数据...';
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
    var el = document.getElementById('lastRefresh');
    el.textContent = time ? '最后刷新: ' + time : '尚未筛选';
}

function resetProgress() {
    document.querySelectorAll('.step').forEach(function(el) { el.classList.remove('completed', 'active'); });
    document.querySelectorAll('.step-count').forEach(function(el) { el.textContent = ''; });
    document.querySelectorAll('.step-connector').forEach(function(el) { el.classList.remove('done'); });
}

function updateStep(stepNum, count, status) {
    var stepEl = document.querySelector('.step[data-step="' + stepNum + '"]');
    var connectorEl = stepNum > 1 ? stepEl.previousElementSibling : null;
    if (status === 'active') { stepEl.classList.add('active'); stepEl.classList.remove('completed'); }
    else if (status === 'completed') {
        stepEl.classList.remove('active'); stepEl.classList.add('completed');
        if (connectorEl) connectorEl.classList.add('done');
    }
    if (count !== undefined && count !== null) stepEl.querySelector('.step-count').textContent = count;
}

function renderStockList(containerId, stocks) {
    var container = document.getElementById(containerId);
    if (!stocks || stocks.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:20px"><p class="empty-text">无符合条件的股票</p></div>';
        return;
    }
    var html = '';
    stocks.forEach(function(s) {
        var cv = s.f3, cClass = cv >= 0 ? 'up' : 'down', cSign = cv >= 0 ? '+' : '';
        var mktCapYi = (s.f21 / 100000000).toFixed(0);
        var ndHtml = '';
        if (s.nextDayChange !== undefined) {
            var ndc = s.nextDayChange;
            var ndClass = ndc >= 0 ? 'up' : 'down', ndSign = ndc >= 0 ? '+' : '';
            var ndLabel = ndc >= 0 ? '次交易日9:30-10:00最高涨幅' : '次交易日9:30-10:00最小跌幅';
            ndHtml += '<div class="detail-item detail-next"><span class="detail-label">' + ndLabel + '</span>' +
                '<span class="detail-value next-change ' + ndClass + '">' + ndSign + ndc.toFixed(2) + '%</span></div>';
            if (s.nextDayCloseChange !== undefined) {
                if (s.nextDayCloseChange === null) {
                    ndHtml += '<div class="detail-item detail-next"><span class="detail-label">次交易日收盘</span>' +
                        '<span class="detail-value" style="color:#888">未收盘</span></div>';
                } else {
                    var ndcc = s.nextDayCloseChange;
                    var ndccClass = ndcc >= 0 ? 'up' : 'down', ndccSign = ndcc >= 0 ? '+' : '';
                    var ndccLabel = ndcc >= 0 ? '次交易日收盘涨幅' : '次交易日收盘跌幅';
                    ndHtml += '<div class="detail-item detail-next"><span class="detail-label">' + ndccLabel + '</span>' +
                        '<span class="detail-value next-change ' + ndccClass + '">' + ndccSign + ndcc.toFixed(2) + '%</span></div>';
                }
            }
        }
        html += '<div class="stock-card"><div class="stock-card-header">' +
            '<div><span class="stock-code">' + s.f12 + '</span><span class="stock-name">' + s.f14 + '</span></div>' +
            '<span class="stock-change ' + cClass + '">' + cSign + cv.toFixed(2) + '%</span></div>' +
            '<div class="stock-details">' +
            '<div class="detail-item"><span class="detail-label">最新价</span><span class="detail-value">' + (s.f2 ? s.f2.toFixed(2) : '--') + '</span></div>' +
            '<div class="detail-item"><span class="detail-label">量比</span><span class="detail-value">' + (s.f10 ? s.f10.toFixed(2) : '--') + '</span></div>' +
            '<div class="detail-item"><span class="detail-label">换手率</span><span class="detail-value">' + (s.f8 ? s.f8.toFixed(2) : '--') + '%</span></div>' +
            '<div class="detail-item"><span class="detail-label">流通市值</span><span class="detail-value">' + mktCapYi + '亿</span></div>' +
            ndHtml + '</div></div>';
    });
    container.innerHTML = html;
}

function showResultSection(sectionId, show) {
    document.getElementById(sectionId).style.display = show ? 'block' : 'none';
}

function updateResultCount(elementId, count) {
    document.getElementById(elementId).textContent = count;
}

function setRefreshButton(disabled) {
    var btn = document.getElementById('btnRefresh');
    btn.disabled = disabled;
    btn.querySelector('.btn-text').textContent = disabled ? '筛选中...' : '开始筛选';
}
