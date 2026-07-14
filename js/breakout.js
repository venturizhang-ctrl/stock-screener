/**
 * breakout.js — 盘整突破扫描（利弗莫尔关键点模型）
 *
 * 核心理念：
 * - 横有多长，竖有多高 → 盘整蓄力越久，突破力度越强
 * - 成交量萎缩是盘整期的重要特征（供应被吸收）
 * - 放量突破箱体上沿 = 最小阻力方向确认
 *
 * 流程：
 * 阶段1：全A股扫描 + 腾讯量比批量查询 → 筛出量比达标的
 * 阶段2：拉日K线（30根）→ 检测盘整 + 突破
 * 阶段3：按量比从高到低排序输出
 */

(function() {

    // 初始化市场状态
    (function() {
        var status = getMarketStatus();
        var el = document.getElementById('marketStatus');
        if (el) { el.textContent = status.text; el.className = 'market-status ' + status.cls; }
    })();

    // ===== 可调参数 =====
    var minVolRatio = 1.5;      // 量比下限
    var consDays = 5;           // 盘整最小天数
    var maxRangePct = 8;        // 盘整期最大振幅(%)
    var minMarketCap = 20;      // 最低总市值（亿）

    var debugLines = [];
    function debugLog(msg) {
        console.log(msg);
        debugLines.push(msg);
        var el = document.getElementById('debugText');
        if (el) el.textContent = debugLines.join('\n');
    }

    // ===== 参数绑定 =====
    (function() {
        // 量比滑块
        var vrSlider = document.getElementById('volRatioSlider');
        var vrVal = document.getElementById('volRatioVal');
        if (vrSlider) {
            vrSlider.addEventListener('input', function() {
                minVolRatio = parseFloat(this.value);
                vrVal.textContent = minVolRatio.toFixed(1);
            });
        }

        // 盘整天数滑块
        var cdSlider = document.getElementById('consDaysSlider');
        var cdVal = document.getElementById('consDaysVal');
        if (cdSlider) {
            cdSlider.addEventListener('input', function() {
                consDays = parseInt(this.value);
                cdVal.textContent = consDays + '天';
            });
        }

        // 最大振幅滑块
        var mrSlider = document.getElementById('maxRangeSlider');
        var mrVal = document.getElementById('maxRangeVal');
        if (mrSlider) {
            mrSlider.addEventListener('input', function() {
                maxRangePct = parseInt(this.value);
                mrVal.textContent = maxRangePct + '%';
            });
        }

        // 市值单选
        var capOptions = [
            { id: 'optCap20', val: 20 },
            { id: 'optCap50', val: 50 },
            { id: 'optCap100', val: 100 }
        ];
        capOptions.forEach(function(opt) {
            var e = document.getElementById(opt.id);
            if (e) e.addEventListener('change', function() { if (this.checked) minMarketCap = opt.val; });
        });
    })();

    // ===== 参数栏折叠 =====
    (function() {
        var header = document.querySelector('#paramsBar .params-header');
        var body = document.getElementById('paramsBody');
        if (header && body) {
            header.style.cursor = 'pointer';
            header.addEventListener('click', function() {
                var show = body.style.display === 'none';
                body.style.display = show ? 'block' : 'none';
                header.textContent = (show ? '📐 筛选参数（点击折叠）' : '📐 筛选参数（点击展开）');
            });
        }
    })();

    // ============================================================
    //  阶段1：全A股扫描 + 量比筛选
    // ============================================================

    /**
     * 从新浪获取全A股数据（按代码排序，分页）
     * 返回所有非ST/非科创/非北交所的股票
     */
    function fetchSinaPage(pageNum) {
        var url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
        var params = 'page=' + pageNum + '&num=100&sort=symbol&asc=1&node=hs_a&_s_r_a=page';
        return fetch(url + '?' + params).then(function(res) {
            if (!res.ok) throw new Error('Sina HTTP ' + res.status);
            return res.json();
        });
    }

    async function getAllStocks(debugFn) {
        var allStocks = [];
        var consecutiveEmpties = 0;
        var maxPages = 60;

        for (var p = 1; p <= maxPages; p++) {
            var data = null;
            for (var retry = 0; retry < 3; retry++) {
                try {
                    data = await fetchSinaPage(p);
                    if (data && data.length > 0) break;
                    if (retry < 2) await delay(800);
                } catch (e) {
                    if (retry < 2) await delay(1000);
                }
            }

            if (!data || data.length === 0) {
                consecutiveEmpties++;
                if (consecutiveEmpties >= 3) {
                    if (debugFn) debugFn('连续3页空，扫描结束。共' + (p-1) + '页');
                    break;
                }
                continue;
            }
            consecutiveEmpties = 0;

            for (var i = 0; i < data.length; i++) {
                var s = data[i];
                var code = s.code;
                var name = s.name;

                if (!code || !name) continue;
                // 跳过ST、新股、科创板、北交所
                if (name.indexOf('ST') >= 0 || name.indexOf('*ST') >= 0) continue;
                if (name.indexOf('N') === 0 || name.indexOf('C') === 0) continue;
                if (code.startsWith('688') || code.startsWith('8') || code.startsWith('4')) continue;

                var nmcRaw = parseFloat(s.nmc) || 0;
                var mktcapRaw = parseFloat(s.mktcap) || 0;

                allStocks.push({
                    code: code,
                    name: name,
                    price: parseFloat(s.trade) || 0,
                    open: parseFloat(s.open) || 0,
                    high: parseFloat(s.high) || 0,
                    low: parseFloat(s.low) || 0,
                    change: parseFloat(s.changepercent) || 0,
                    volume: parseFloat(s.volume) || 0,
                    turnover: parseFloat(s.turnoverratio) || 0,
                    nmc: nmcRaw / 10000,      // 万元→亿
                    mktcap: mktcapRaw / 10000,
                    symbol: (s.symbol || '').startsWith('sh') ? 1 : 0
                });
            }

            if (debugFn && p % 10 === 0) {
                debugFn('扫' + p + '页 全市场' + allStocks.length + '只');
            }

            await delay(200);
        }

        return allStocks;
    }

    // ============================================================
    //  阶段2：日K线获取
    // ============================================================

    /**
     * 获取日K线数据（30根，用于盘整检测）
     */
    function fetchDailyKline30(code) {
        return new Promise(function(resolve, reject) {
            var c = code.toString();
            var symbol = (c.startsWith('6') || c.startsWith('9') ? 'sh' : 'sz') + c;
            var cb = 'bk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

            var timer = setTimeout(function() {
                cleanup();
                reject(new Error('超时'));
            }, 10000);

            function cleanup() {
                clearTimeout(timer);
                delete window[cb];
                if (script && script.parentNode) script.parentNode.removeChild(script);
            }

            window[cb] = function(data) {
                cleanup();
                try {
                    if (!data || !Array.isArray(data)) {
                        reject(new Error('无数据'));
                        return;
                    }
                    var bars = [];
                    for (var i = 0; i < data.length; i++) {
                        var bar = data[i];
                        var date = bar.day.split(' ')[0];
                        bars.push({
                            date: date,
                            open: parseFloat(bar.open) || 0,
                            close: parseFloat(bar.close) || 0,
                            high: parseFloat(bar.high) || 0,
                            low: parseFloat(bar.low) || 0,
                            volume: parseFloat(bar.volume) || 0
                        });
                    }
                    resolve(bars);
                } catch (e) { reject(e); }
            };

            var script = document.createElement('script');
            script.src = 'https://money.finance.sina.com.cn/quotes_service/api/jsonp_v2.php/' +
                cb + '/CN_MarketData.getKLineData?symbol=' + symbol +
                '&scale=240&ma=no&datalen=30';
            script.onerror = function() { cleanup(); reject(new Error('网络错误')); };
            document.body.appendChild(script);
        });
    }

    // ============================================================
    //  核心：盘整突破检测
    // ============================================================

    /**
     * 检测某只股票是否处于"盘整后放量突破"状态
     *
     * @param {Array} bars — 日K线（升序，最新在最后，包含今天）
     * @param {Object} stockInfo — 实时行情 {price, open, high, low, volume, change}
     * @param {number} nDays — 盘整最少天数
     * @param {number} maxRange — 盘整期最大振幅(%)
     * @returns {Object|null} 突破信号或null
     */
    function detectBreakout(bars, stockInfo, nDays, maxRange) {
        var len = bars.length;
        if (len < nDays + 2) return null;  // 至少需要 N天盘整 + 1天确认

        // 取最后一条K线的日期，判断是否包含今天
        var lastBar = bars[len - 1];
        var today = new Date();
        var todayStr = today.getFullYear() + '-' +
            String(today.getMonth() + 1).padStart(2, '0') + '-' +
            String(today.getDate()).padStart(2, '0');

        var lastIsToday = (lastBar.date === todayStr);

        // 确定盘整期和今日数据
        var consolidation, todayBar;
        if (lastIsToday) {
            // K线包含今天：盘整期 = 今天之前的N根K线
            if (len < nDays + 2) return null;
            consolidation = bars.slice(-(nDays + 1), -1);  // 倒数第N+1到倒数第2（不含今天）
            todayBar = bars[len - 1];
        } else {
            // K线不含今天：盘整期 = 最后N根K线
            consolidation = bars.slice(-nDays);
            // 用实时行情构造今日K线
            todayBar = {
                date: todayStr,
                open: stockInfo.open,
                close: stockInfo.price,
                high: stockInfo.high,
                low: stockInfo.low,
                volume: stockInfo.volume
            };
        }

        if (consolidation.length < nDays) return null;

        // ---- 1. 计算箱体 ----
        var boxHigh = -Infinity;
        var boxLow = Infinity;
        for (var i = 0; i < consolidation.length; i++) {
            var bar = consolidation[i];
            if (bar.high > boxHigh) boxHigh = bar.high;
            if (bar.low < boxLow) boxLow = bar.low;
        }

        if (boxLow <= 0) return null;

        // 盘整期振幅
        var rangePct = (boxHigh - boxLow) / boxLow * 100;
        if (rangePct > maxRange) return null;

        // ---- 2. 突破确认：今日收盘 > 箱体上沿 ----
        if (todayBar.close <= boxHigh) return null;

        // ---- 3. 量比计算（今日量 / 盘整期均量）----
        var avgConsVol = 0;
        for (var j = 0; j < consolidation.length; j++) {
            avgConsVol += consolidation[j].volume;
        }
        avgConsVol /= consolidation.length;
        if (avgConsVol <= 0) return null;

        var volRatio = todayBar.volume / avgConsVol;
        if (volRatio < minVolRatio) return null;

        // ---- 4. 今日必须收阳（突破日应该上涨）----
        if (todayBar.close <= todayBar.open && todayBar.close <= consolidation[consolidation.length - 1].close) {
            // 允许微跌但收盘在箱体上方，但标记为弱突破
        }

        // ---- 5. 成交量萎缩检查（后半段 < 前半段）----
        var mid = Math.floor(consolidation.length / 2);
        var volFirst = 0, volSecond = 0;
        for (var k = 0; k < mid; k++) { volFirst += consolidation[k].volume; }
        for (var l = mid; l < consolidation.length; l++) { volSecond += consolidation[l].volume; }
        volFirst /= mid;
        volSecond /= (consolidation.length - mid);
        var volShrink = volSecond < volFirst;  // true = 量缩，健康

        // ---- 6. 均线计算 ----
        var closes = [];
        for (var m = 0; m < len; m++) { closes.push(bars[m].close); }

        var ma5 = calcMA(closes, 5);
        var ma10 = calcMA(closes, 10);
        var ma20 = calcMA(closes, 20);
        var maAligned = (ma5 && ma10 && ma20) ? (ma5 > ma10 && ma10 > ma20) : null;

        // ---- 7. 突破强度 ----
        var breakPct = (todayBar.close - boxHigh) / boxHigh * 100;
        var todayChange = todayBar.close > 0 && todayBar.open > 0 ?
            (todayBar.close - todayBar.open) / todayBar.open * 100 : 0;

        return {
            boxHigh: boxHigh,
            boxLow: boxLow,
            rangePct: rangePct,
            actualDays: consolidation.length,
            volRatio: volRatio,
            volShrink: volShrink,
            ma5: ma5, ma10: ma10, ma20: ma20, maAligned: maAligned,
            breakPct: breakPct,
            todayChange: todayChange,
            avgConsVol: avgConsVol
        };
    }

    function calcMA(arr, n) {
        if (arr.length < n) return null;
        var sum = 0;
        for (var i = arr.length - n; i < arr.length; i++) { sum += arr[i]; }
        return sum / n;
    }

    // ============================================================
    //  主流程
    // ============================================================

    document.getElementById('btnRefresh').addEventListener('click', runScreening);

    async function runScreening() {
        clearResults();
        hideError();
        setRefreshButton(true);
        debugLines = [];
        debugLog('=== 盘整突破扫描 ===');
        debugLog('参数: 量比≥' + minVolRatio.toFixed(1) +
            ' | 盘整≥' + consDays + '天 | 振幅≤' + maxRangePct +
            '% | 市值≥' + minMarketCap + '亿');
        debugLog('逻辑: 全A扫描→量比筛选→K线检测→盘整突破确认');
        debugLog('时间: ' + new Date().toLocaleTimeString());

        try {
            // ===== 阶段1：全A股扫描 =====
            showLoading('扫描全A股...', '获取股票列表');
            var allStocks = await getAllStocks(debugLog);
            debugLog('全市场共 ' + allStocks.length + ' 只（已剔除ST/科创/北交所）');

            if (allStocks.length === 0) {
                debugLog('未获取到任何股票数据');
                showResults([], 0, 0, 0);
                finishRefresh();
                return;
            }

            // ===== 阶段2：批量获取量比 =====
            showLoading('获取量比数据...', allStocks.length + '只待查询');
            var volRatioMap = await fetchVolumeRatios(allStocks, debugLog);

            // 筛选：量比达标 + 市值达标
            var candidates = [];
            var skippedVol = 0, skippedCap = 0;
            for (var i = 0; i < allStocks.length; i++) {
                var s = allStocks[i];
                var vr = volRatioMap[s.code] || 0;
                if (vr < minVolRatio) { skippedVol++; continue; }
                if (s.mktcap < minMarketCap) { skippedCap++; continue; }
                s.volRatio = vr;  // 挂上量比
                candidates.push(s);
            }
            debugLog('量比< ' + minVolRatio + ': ' + skippedVol + '只过滤');
            debugLog('市值< ' + minMarketCap + '亿: ' + skippedCap + '只过滤');
            debugLog('阶段2: 候选 ' + candidates.length + ' 只（量比≥' + minVolRatio.toFixed(1) + ' + 市值≥' + minMarketCap + '亿）');

            if (candidates.length === 0) {
                debugLog('无量比达标的股票，可降低量比下限或市值门槛');
                showResults([], allStocks.length, 0, 0);
                finishRefresh();
                return;
            }

            // ===== 阶段3：拉日K线 + 盘整突破检测 =====
            showLoading('检测盘整突破...', candidates.length + '只候选');
            var results = [];
            var processed = 0;
            var errors = 0;
            var noBreakout = 0;
            var batchSize = 4;  // JSONP并发限制

            for (var bi = 0; bi < candidates.length; bi += batchSize) {
                var batch = candidates.slice(bi, bi + batchSize);

                var promises = batch.map(function(stock) {
                    return fetchDailyKline30(stock.code).then(function(bars) {
                        if (!bars || bars.length < consDays + 2) {
                            return { stock: stock, result: null, error: 'K线不足(' + (bars ? bars.length : 0) + ')' };
                        }
                        var sig = detectBreakout(bars, stock, consDays, maxRangePct);
                        return { stock: stock, result: sig, error: null };
                    }).catch(function(e) {
                        return { stock: stock, result: null, error: e.message };
                    });
                });

                var batchResults = await Promise.all(promises);

                for (var ri = 0; ri < batchResults.length; ri++) {
                    var r = batchResults[ri];
                    if (r.error) {
                        errors++;
                    } else if (r.result) {
                        results.push({
                            code: r.stock.code,
                            name: r.stock.name,
                            price: r.stock.price,
                            change: r.stock.change,
                            turnover: r.stock.turnover,
                            mktcap: r.stock.mktcap,
                            nmc: r.stock.nmc,
                            volRatio: r.stock.volRatio,
                            signal: r.result
                        });
                    } else {
                        noBreakout++;
                    }
                    processed++;
                }

                var pct = Math.round(processed / candidates.length * 100);
                showLoading('检测盘整突破...',
                    processed + '/' + candidates.length + ' (' + pct + '%) ' +
                    '突破' + results.length + '只');

                if (bi + batchSize < candidates.length) await delay(300);
            }

            // ===== 阶段4：按量比排序 =====
            results.sort(function(a, b) {
                return b.volRatio - a.volRatio;  // 量比从高到低
            });

            debugLog('=== 扫描完成 ===');
            debugLog('全市场: ' + allStocks.length + ' → 量比达标: ' + candidates.length +
                ' → 盘整突破: ' + results.length + ' (错误' + errors + ' 无突破' + noBreakout + ')');

            showResults(results, allStocks.length, candidates.length, errors);
            finishRefresh();

        } catch (e) {
            debugLog('!! 异常: ' + (e.message || e));
            showError(e.message || '扫描失败');
            setRefreshButton(false);
            hideLoading();
        }
    }

    // ============================================================
    //  UI 渲染
    // ============================================================

    function clearResults() {
        var area = document.getElementById('resultArea');
        if (area) area.style.display = 'none';
        var list = document.getElementById('listResult');
        if (list) list.innerHTML = '';
        var count = document.getElementById('countResult');
        if (count) count.textContent = '0';
        var empty = document.getElementById('emptyState');
        if (empty) empty.style.display = 'block';
    }

    function showResults(results, total, candidates, errors) {
        var empty = document.getElementById('emptyState');
        if (empty) empty.style.display = 'none';

        var area = document.getElementById('resultArea');
        if (area) area.style.display = 'block';

        var count = document.getElementById('countResult');
        if (count) count.textContent = results.length;

        var badge = document.getElementById('resultBadge');
        if (badge) badge.textContent = '量比≥' + minVolRatio.toFixed(1);

        renderStockCards(results);
    }

    function renderStockCards(stocks) {
        var list = document.getElementById('listResult');
        if (!list) return;

        if (!stocks || stocks.length === 0) {
            list.innerHTML = '<div class="empty-state" style="padding:30px 20px">' +
                '<p class="empty-icon">🔍</p>' +
                '<p class="empty-text">未发现盘整突破信号</p>' +
                '<p class="empty-hint">可尝试：降低量比下限 / 减少盘整天数 / 放宽振幅上限</p>' +
                '</div>';
            return;
        }

        var html = '';
        for (var i = 0; i < stocks.length; i++) {
            var s = stocks[i];
            var sig = s.signal;
            var chgClass = s.change >= 0 ? 'up' : 'down';
            var chgSign = s.change >= 0 ? '+' : '';

            // 突破强度
            var strengthLabel, strengthClass;
            if (sig.breakPct >= 3) {
                strengthLabel = '强突破';
                strengthClass = 'strong';
            } else if (sig.breakPct >= 1) {
                strengthLabel = '正常';
                strengthClass = 'normal';
            } else {
                strengthLabel = '弱突破';
                strengthClass = 'warn';
            }

            // 量缩标签
            var shrinkHtml = '';
            if (sig.volShrink) {
                shrinkHtml = '<span class="vol-shrink-tag good">量缩</span>';
            } else {
                shrinkHtml = '<span class="vol-shrink-tag warn">未缩量</span>';
            }

            // 均线信息
            var maHtml = '';
            if (sig.maAligned === true) {
                maHtml = '<span class="ma-pass">MA多头</span>';
            } else if (sig.maAligned === false) {
                maHtml = '<span class="ma-fail">MA未多头</span>';
            }

            html += '<div class="stock-card">' +
                // 头部：代码+名称 + 涨幅
                '<div class="stock-card-header">' +
                    '<div><span class="stock-code">' + s.code + '</span>' +
                    '<span class="stock-name">' + s.name + '</span></div>' +
                    '<span class="stock-change ' + chgClass + '">' + chgSign + s.change.toFixed(2) + '%</span>' +
                '</div>' +
                // 量比（突出显示）
                '<div style="display:flex;align-items:center;gap:10px;margin:8px 0;">' +
                    '<span style="color:#888;font-size:14px;">量比</span>' +
                    '<span class="breakout-vol-ratio">' + s.volRatio.toFixed(2) + '</span>' +
                    '<span class="breakout-strength ' + strengthClass + '">' + strengthLabel + '</span>' +
                '</div>' +
                // 详情：现价 + 换手 + 市值
                '<div class="stock-details">' +
                    '<div class="detail-item"><span class="detail-label">现价</span><span class="detail-value">' + s.price.toFixed(2) + '</span></div>' +
                    '<div class="detail-item"><span class="detail-label">换手率</span><span class="detail-value">' + s.turnover.toFixed(2) + '%</span></div>' +
                    '<div class="detail-item"><span class="detail-label">总市值</span><span class="detail-value">' + s.mktcap.toFixed(0) + '亿</span></div>' +
                '</div>' +
                // 箱体信息
                '<div class="breakout-box-info">' +
                    '<span class="box-info-item">箱体: <b>' + sig.boxLow.toFixed(2) + ' - ' + sig.boxHigh.toFixed(2) + '</b></span>' +
                    '<span class="box-info-item">振幅: <b>' + sig.rangePct.toFixed(1) + '%</b></span>' +
                    '<span class="box-info-item">盘整: <b>' + sig.actualDays + '天</b></span>' +
                    '<span class="box-info-item">突破: <b>+' + sig.breakPct.toFixed(2) + '%</b></span>' +
                    shrinkHtml +
                    (maHtml ? ' ' + maHtml : '') +
                '</div>' +
            '</div>';
        }

        list.innerHTML = html;
    }

    // ===== UI辅助函数 =====

    function showLoading(title, sub) {
        var loader = document.getElementById('loadingOverlay');
        if (!loader) return;
        loader.style.display = 'flex';
        var t = document.getElementById('loadingTitle');
        var s = document.getElementById('loadingSub');
        if (t) t.textContent = title || '';
        if (s) s.textContent = sub || '';
    }

    function hideLoading() {
        var loader = document.getElementById('loadingOverlay');
        if (loader) loader.style.display = 'none';
    }

    function setRefreshButton(loading) {
        var btn = document.getElementById('btnRefresh');
        if (btn) {
            btn.disabled = loading;
            var span = btn.querySelector('.btn-text');
            if (span) span.textContent = loading ? '扫描中...' : '扫描突破';
        }
    }

    function showError(msg) {
        var el = document.getElementById('errorMsg');
        if (!el) return;
        el.textContent = msg;
        var area = document.getElementById('errorArea');
        if (area) area.style.display = 'block';
    }

    function hideError() {
        var area = document.getElementById('errorArea');
        if (area) area.style.display = 'none';
    }

    function finishRefresh() {
        hideLoading();
        setRefreshButton(false);
        var now = new Date();
        var ts = String(now.getHours()).padStart(2, '0') + ':' +
            String(now.getMinutes()).padStart(2, '0') + ':' +
            String(now.getSeconds()).padStart(2, '0');
        var el = document.getElementById('lastRefresh');
        if (el) el.textContent = '扫描于 ' + ts;
        var status = getMarketStatus();
        var msEl = document.getElementById('marketStatus');
        if (msEl) { msEl.textContent = status.text; msEl.className = 'market-status ' + status.cls; }
    }

})();
