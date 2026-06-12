/**
 * ui.js — UI渲染
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

function updateWeekSelector(weeks) {
    document.querySelectorAll('.week-btn').forEach(function(btn) {
        if (parseInt(btn.getAttribute('data-weeks')) === weeks) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

function renderStockList(containerId, stocks) {
    var container = document.getElementById(containerId);
    if (!stocks || stocks.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:20px"><p class="empty-text">无符合条件的股票</p></div>';
        return;
    }
    var html = '';
    stocks.forEach(function(s) {
        var wr = s.weeklyResult;
        var totalChange = 0;
        if (wr && wr.weeklyChanges && wr.weeklyChanges.length > 0) {
            var factor = 1;
            wr.weeklyChanges.forEach(function(c) { factor *= (1 + c / 100); });
            totalChange = (factor - 1) * 100;
        }
        var tcClass = totalChange >= 0 ? 'up' : 'down';
        var tcSign = totalChange >= 0 ? '+' : '';

        var weeklyRows = '';
        if (wr && wr.weeklyChanges && wr.weeklyChanges.length > 0) {
            weeklyRows = '<div class="weekly-changes">';
            wr.weeklyChanges.forEach(function(change, idx) {
                var wClass = change >= 0 ? 'up' : 'down';
                var wSign = change >= 0 ? '+' : '';
                var turnover = (wr.weeklyTurnovers && wr.weeklyTurnovers[idx]) ? wr.weeklyTurnovers[idx] : 0;
                weeklyRows += '<span class="week-chip ' + wClass + '">周' + (idx + 1) +
                    ' ' + wSign + change.toFixed(2) + '%' +
                    ' 换手' + turnover.toFixed(1) + '%</span>';
            });
            weeklyRows += '</div>';
        }

        html += '<div class="stock-card"><div class="stock-card-header">' +
            '<div><span class="stock-code">' + s.f12 + '</span><span class="stock-name">' + s.f14 + '</span></div>' +
            '<span class="stock-change ' + tcClass + '">' + tcSign + totalChange.toFixed(2) + '%</span></div>' +
            '<div class="stock-details">' +
            '<div class="detail-item"><span class="detail-label">最新价</span><span class="detail-value">' + (s.f2 ? s.f2.toFixed(2) : '--') + '</span></div>' +
            '<div class="detail-item"><span class="detail-label">流通市值</span><span class="detail-value">' + (s.nmcYi || '--') + '亿</span></div>' +
            '</div>' + weeklyRows + '</div>';
    });
    container.innerHTML = html;
}
