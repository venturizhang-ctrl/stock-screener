/**
 * reversal.js — 近5日吞没形态扫描（看跌吞没 + 看涨吞没）
 *
 * 核心理念：
 * - 看跌吞没（Bearish Engulfing）：阳线 + 阴线完全覆盖 → 强转弱
 * - 看涨吞没（Bullish Engulfing）：阴线 + 阳线完全覆盖 → 弱转强
 * - 扫描最近5个交易日内的吞没形态
 *
 * 2:40 快筛模式：
 * - 仅看涨吞没 + 仅今日触发 + 四因子质量评分
 * - 目标卖价 ≈ 现价 × (1 + 下破×2)
 *
 * 流程：
 * 阶段1：全A股扫描 → 市值筛选
 * 阶段2：拉日K线（20根）→ 检测近5日吞没形态
 * 阶段3：按反转强度从高到低排序输出
 */

(function() {

    // 初始化市场状态
    (function() {
        var status = getMarketStatus();
        var el = document.getElementById('marketStatus');
        if (el) { el.textContent = status.text; el.className = 'market-status ' + status.cls; }
    })();

    // ===== 可调参数 =====
    var minBodyPct = 1.0;       // 前日实体最小幅度(%)，阳线看涨幅、阴线看跌幅
    var minVolExpand = 1.2;     // 放量倍数下限
    var minMarketCap = 20;      // 最低总市值（亿）
    var filterDirection = 'all'; // 'all' | 'bearish' | 'bullish'
    var quickMode = false;      // 2:40 快筛模式

    var debugLines = [];
    function debugLog(msg) {
        console.log(msg);
        debugLines.push(msg);
        var el = document.getElementById('debugText');
        if (el) el.textContent = debugLines.join('\n');
    }

    // ===== 参数绑定 =====
    (function() {
        var bsSlider = document.getElementById('bodyPctSlider');
        var bsVal = document.getElementById('bodyPctVal');
        if (bsSlider) {
            bsSlider.addEventListener('input', function() {
                minBodyPct = parseFloat(this.value);
                bsVal.textContent = minBodyPct.toFixed(1) + '%';
            });
        }

        var veSlider = document.getElementById('volExpandSlider');
        var veVal = document.getElementById('volExpandVal');
        if (veSlider) {
            veSlider.addEventListener('input', function() {
                minVolExpand = parseFloat(this.value);
                veVal.textContent = minVolExpand.toFixed(1) + 'x';
            });
        }

        var capOptions = [
            { id: 'optCap20', val: 20 },
            { id: 'optCap50', val: 50 },
            { id: 'optCap100', val: 100 }
        ];
        capOptions.forEach(function(opt) {
            var e = document.getElementById(opt.id);
            if (e) e.addEventListener('change', function() { if (this.checked) minMarketCap = opt.val; });
        });

        // 方向筛选
        var dirAll = document.getElementById('optDirAll');
        var dirBear = document.getElementById('optDirBear');
        var dirBull = document.getElementById('optDirBull');
        if (dirAll) dirAll.addEventListener('change', function() { if (this.checked) filterDirection = 'all'; });
        if (dirBear) dirBear.addEventListener('change', function() { if (this.checked) filterDirection = 'bearish'; });
        if (dirBull) dirBull.addEventListener('change', function() { if (this.checked) filterDirection = 'bullish'; });
    })();

    // ===== 2:40 快筛按钮 + 时间检查 =====

    function getTimeWindow() {
        var now = new Date();
        var day = now.getDay();
        var t = now.getHours() * 100 + now.getMinutes();

        if (day === 0 || day === 6) return { ok: false, label: '周末休市', msg: '周末休市，无今日信号。可以用全量扫描看历史信号。' };
        if (t < 930) return { ok: false, label: '等待开盘', msg: '尚未开盘，快筛无意义。' };
        if (t < 1430) return { ok: false, label: 'K线未定型', msg: '现在' + now.getHours() + ':' + String(now.getMinutes()).padStart(2,'0') + '，日K线还在变化中。\n\n建议等到 14:30 后再快筛，信号更可靠。\n\n仍然要扫吗？' };
        if (t <= 1505) return { ok: true, label: '✅ 黄金窗口', msg: null };
        return { ok: true, label: '已收盘', msg: null };
    }

    document.getElementById('btnQuickScan').addEventListener('click', async function() {
        var tw = getTimeWindow();
        if (!tw.ok) {
            var proceed = await myConfirm(tw.msg);
            if (!proceed) return;
        }
        quickMode = true;
        runScreening();
    });
    document.getElementById('btnFullScan').addEventListener('click', function() {
        quickMode = false;
        runScreening();
    });

    // 实时更新时间窗口标签
    (function updateTimeWindow() {
        var tw = getTimeWindow();
        var msEl = document.getElementById('marketStatus');
        if (msEl) { msEl.textContent = tw.label; msEl.className = tw.ok ? 'market-status trading' : 'market-status closed'; }
        setTimeout(updateTimeWindow, 30000);
    })();

    // ===== 四因子质量评分 =====

    /**
     * 对看涨吞没信号做四因子质量评分
     *  1. 覆盖倍数 1.5~3x
     *  2. 放量倍数 1.3~2.5x
     *  3. 上穿率 > 0.5%
     *  4. 下破率 1~3%
     *  @returns {{ level: string, score: number, details: Array, targetPct: number, stopPct: number }}
     */
    function scoreQuality(sig) {
        var score = 0;
        var details = [];
        var isBearish = (sig.direction === 'bearish');

        // 因子1：覆盖倍数
        var bodyOk = (sig.bodyRatio >= 1.5 && sig.bodyRatio <= 3.0);
        if (bodyOk) score++;
        details.push({ name: '覆盖倍数', value: sig.bodyRatio.toFixed(1) + 'x', ok: bodyOk, hint: '1.5~3x' });

        // 因子2：放量倍数
        var volOk = (sig.volExpand >= 1.3 && sig.volExpand <= 2.5);
        if (volOk) score++;
        details.push({ name: '放量', value: sig.volExpand.toFixed(1) + 'x', ok: volOk, hint: '1.3~2.5x' });

        // 因子3：上穿率
        var upOk = (sig.upperPierce > 0.5);
        if (upOk) score++;
        details.push({ name: '上穿', value: sig.upperPierce.toFixed(1) + '%', ok: upOk, hint: '>0.5%' });

        // 因子4：下破率（核心）
        var dnOk = (sig.lowerPierce >= 1.0 && sig.lowerPierce <= 3.0);
        if (dnOk) score++;
        details.push({ name: '下破', value: sig.lowerPierce.toFixed(1) + '%', ok: dnOk, hint: '1~3%' });

        var level = score >= 4 ? 'excellent' : (score >= 3 ? 'good' : 'warning');

        // 目标卖价（仅看涨吞没有意义）
        var targetPct = sig.lowerPierce * 2;
        var stopPct = sig.bar1Pct;  // 止损 = 前日阴线低点再往下一点

        return { score: score, level: level, details: details, targetPct: targetPct, stopPct: stopPct };
    }

    // ===== 参数栏折叠 =====
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
    //  阶段1：全A股扫描
    // ============================================================

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
                if (name.indexOf('ST') >= 0 || name.indexOf('*ST') >= 0) continue;
                if (name.indexOf('N') === 0 || name.indexOf('C') === 0) continue;
                if (code.startsWith('688') || code.startsWith('8') || code.startsWith('4')) continue;

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
                    nmc: (parseFloat(s.nmc) || 0) / 10000,
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

    function fetchDailyKline(code) {
        return new Promise(function(resolve, reject) {
            var c = code.toString();
            var symbol = (c.startsWith('6') || c.startsWith('9') ? 'sh' : 'sz') + c;
            var cb = 'rv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

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
                '&scale=240&ma=no&datalen=20';
            script.onerror = function() { cleanup(); reject(new Error('网络错误')); };
            document.body.appendChild(script);
        });
    }

    // ============================================================
    //  核心：吞没形态检测
    // ============================================================

    /**
     * 检查看跌吞没：bar1阳线 + bar2阴线完全覆盖
     * @returns {Object|null}
     */
    function checkBearishPair(bar1, bar2) {
        if (!bar1.open || !bar2.open) return null;

        // bar1 必须是阳线
        if (bar1.close <= bar1.open) return null;
        var bar1Pct = (bar1.close - bar1.open) / bar1.open * 100;
        if (bar1Pct < minBodyPct) return null;

        // bar2 必须是阴线
        if (bar2.close >= bar2.open) return null;

        // 阴线实体覆盖阳线实体
        if (bar2.open <= bar1.close) return null;   // 阴开 > 阳收
        if (bar2.close >= bar1.open) return null;   // 阴收 < 阳开

        // 阴线影线覆盖阳线影线
        if (bar2.high <= bar1.high) return null;
        if (bar2.low >= bar1.low) return null;

        // 放量
        var volExpand = (bar1.volume > 0 && bar2.volume > 0) ? bar2.volume / bar1.volume : 0;
        if (volExpand < minVolExpand) return null;

        var engulfBody = bar2.open - bar2.close;
        var prevBody = bar1.close - bar1.open;
        var bodyRatio = prevBody > 0 ? engulfBody / prevBody : 0;
        var engulfPct = (bar2.open - bar2.close) / bar2.open * 100;
        var upperPierce = bar1.high > 0 ? (bar2.high - bar1.high) / bar1.high * 100 : 0;
        var lowerPierce = bar1.low > 0 ? (bar1.low - bar2.low) / bar1.low * 100 : 0;
        var score = bodyRatio * 3 + volExpand + upperPierce * 2 + lowerPierce * 2;

        return {
            direction: 'bearish',
            // 前日（阳线）
            bar1Open: bar1.open, bar1Close: bar1.close,
            bar1High: bar1.high, bar1Low: bar1.low,
            bar1Pct: bar1Pct, bar1Volume: bar1.volume, bar1Date: bar1.date,
            bar1Label: '阳线',
            // 后日（阴线）
            bar2Open: bar2.open, bar2Close: bar2.close,
            bar2High: bar2.high, bar2Low: bar2.low,
            bar2Pct: engulfPct, bar2Volume: bar2.volume, bar2Date: bar2.date,
            bar2Label: '阴线',
            // 强度
            bodyRatio: bodyRatio, volExpand: volExpand,
            upperPierce: upperPierce, lowerPierce: lowerPierce,
            score: score
        };
    }

    /**
     * 检查看涨吞没：bar1阴线 + bar2阳线完全覆盖
     * @returns {Object|null}
     */
    function checkBullishPair(bar1, bar2) {
        if (!bar1.open || !bar2.open) return null;

        // bar1 必须是阴线
        if (bar1.close >= bar1.open) return null;
        var bar1Pct = (bar1.open - bar1.close) / bar1.open * 100;
        if (bar1Pct < minBodyPct) return null;

        // bar2 必须是阳线
        if (bar2.close <= bar2.open) return null;

        // 阳线实体覆盖阴线实体
        if (bar2.close <= bar1.open) return null;   // 阳收 > 阴开
        if (bar2.open >= bar1.close) return null;   // 阳开 < 阴收

        // 阳线影线覆盖阴线影线
        if (bar2.high <= bar1.high) return null;
        if (bar2.low >= bar1.low) return null;

        // 放量
        var volExpand = (bar1.volume > 0 && bar2.volume > 0) ? bar2.volume / bar1.volume : 0;
        if (volExpand < minVolExpand) return null;

        var engulfBody = bar2.close - bar2.open;
        var prevBody = bar1.open - bar1.close;
        var bodyRatio = prevBody > 0 ? engulfBody / prevBody : 0;
        var engulfPct = (bar2.close - bar2.open) / bar2.open * 100;
        var upperPierce = bar1.high > 0 ? (bar2.high - bar1.high) / bar1.high * 100 : 0;
        var lowerPierce = bar1.low > 0 ? (bar1.low - bar2.low) / bar1.low * 100 : 0;
        var score = bodyRatio * 3 + volExpand + upperPierce * 2 + lowerPierce * 2;

        return {
            direction: 'bullish',
            // 前日（阴线）
            bar1Open: bar1.open, bar1Close: bar1.close,
            bar1High: bar1.high, bar1Low: bar1.low,
            bar1Pct: bar1Pct, bar1Volume: bar1.volume, bar1Date: bar1.date,
            bar1Label: '阴线',
            // 后日（阳线）
            bar2Open: bar2.open, bar2Close: bar2.close,
            bar2High: bar2.high, bar2Low: bar2.low,
            bar2Pct: engulfPct, bar2Volume: bar2.volume, bar2Date: bar2.date,
            bar2Label: '阳线',
            // 强度
            bodyRatio: bodyRatio, volExpand: volExpand,
            upperPierce: upperPierce, lowerPierce: lowerPierce,
            score: score
        };
    }

    /**
     * 检测近5日吞没信号
     * 遍历最近5对相邻K线，同时检测看跌和看涨吞没
     */
    function detectReversal(bars, stock) {
        var len = bars.length;
        if (len < 2) return null;

        var today = new Date();
        var todayStr = today.getFullYear() + '-' +
            String(today.getMonth() + 1).padStart(2, '0') + '-' +
            String(today.getDate()).padStart(2, '0');

        // 构建完整K线数组
        var allBars = bars.slice();
        var lastBar = allBars[allBars.length - 1];

        if (lastBar.date !== todayStr) {
            allBars.push({
                date: todayStr,
                open: stock.open,
                close: stock.price,
                high: stock.high,
                low: stock.low,
                volume: stock.volume
            });
        }

        var bestSignal = null;
        var checkCount = Math.min(5, allBars.length - 1);

        for (var offset = 0; offset < checkCount; offset++) {
            var bar2Idx = allBars.length - 1 - offset;   // 较新的K线
            var bar1Idx = bar2Idx - 1;                     // 较旧的K线
            if (bar1Idx < 0) break;

            var bar1 = allBars[bar1Idx];
            var bar2 = allBars[bar2Idx];

            // 根据方向筛选，尝试检测
            var sig = null;
            if (filterDirection === 'all' || filterDirection === 'bearish') {
                sig = checkBearishPair(bar1, bar2);
            }
            if (!sig && (filterDirection === 'all' || filterDirection === 'bullish')) {
                sig = checkBullishPair(bar1, bar2);
            }

            if (sig && (!bestSignal || sig.score > bestSignal.score)) {
                sig.daysAgo = offset;
                bestSignal = sig;
            }
        }

        return bestSignal;
    }

    // ============================================================
    //  主流程
    // ============================================================

    // 按钮绑定已在上面（btnQuickScan + btnFullScan）

    async function runScreening() {
        clearResults();
        hideError();
        setRefreshButton(true);
        debugLines = [];

        // 快筛模式：锁定看涨 + 放宽参数
        var savedDirection = filterDirection;
        if (quickMode) {
            filterDirection = 'bullish';
            minBodyPct = 0.5;   // 放宽实体要求
            minVolExpand = 1.0; // 不卡放量门槛，交给评分
        }

        var dirLabel = filterDirection === 'bearish' ? '仅看跌' : (filterDirection === 'bullish' ? '仅看涨' : '全部');
        var modeLabel = quickMode ? '⚡ 2:40快筛' : '🔍 全量扫描';
        debugLog('=== ' + modeLabel + ' ===');
        debugLog('参数: 前日实体≥' + minBodyPct.toFixed(1) +
            '% | 放量≥' + minVolExpand.toFixed(1) +
            'x | 市值≥' + minMarketCap + '亿 | 方向: ' + dirLabel);
        if (quickMode) {
            debugLog('快筛规则: 仅看涨吞没 + 仅今日 + 四因子评分');
        }
        debugLog('时间: ' + new Date().toLocaleTimeString());

        try {
            showLoading('扫描全A股...', '获取股票列表');
            var allStocks = await getAllStocks(debugLog);
            debugLog('全市场共 ' + allStocks.length + ' 只（已剔除ST/科创/北交所）');

            if (allStocks.length === 0) {
                debugLog('未获取到任何股票数据');
                showResults([]);
                finishRefresh();
                return;
            }

            var candidates = [];
            var skippedCap = 0;
            for (var i = 0; i < allStocks.length; i++) {
                var s = allStocks[i];
                if (s.mktcap < minMarketCap) { skippedCap++; continue; }
                candidates.push(s);
            }
            debugLog('市值< ' + minMarketCap + '亿(跳过): ' + skippedCap + '只');
            debugLog('阶段1: 候选 ' + candidates.length + ' 只');

            if (candidates.length === 0) {
                debugLog('无候选股票');
                showResults([]);
                finishRefresh();
                return;
            }

            showLoading('检测吞没形态...', candidates.length + '只候选');
            var results = [];
            var processed = 0, errors = 0, noSignal = 0;
            var batchSize = 4;

            for (var bi = 0; bi < candidates.length; bi += batchSize) {
                var batch = candidates.slice(bi, bi + batchSize);

                var promises = batch.map(function(stock) {
                    return fetchDailyKline(stock.code).then(function(bars) {
                        if (!bars || bars.length < 2) {
                            return { stock: stock, signal: null, error: 'K线不足' };
                        }
                        var sig = detectReversal(bars, stock);
                        return { stock: stock, signal: sig, error: null };
                    }).catch(function(e) {
                        return { stock: stock, signal: null, error: e.message };
                    });
                });

                var batchResults = await Promise.all(promises);

                for (var ri = 0; ri < batchResults.length; ri++) {
                    var r = batchResults[ri];
                    if (r.error) { errors++; }
                    else if (r.signal) {
                        results.push({
                            code: r.stock.code, name: r.stock.name,
                            price: r.stock.price, change: r.stock.change,
                            turnover: r.stock.turnover, mktcap: r.stock.mktcap,
                            nmc: r.stock.nmc, open: r.stock.open,
                            high: r.stock.high, low: r.stock.low,
                            volume: r.stock.volume, signal: r.signal
                        });
                    } else { noSignal++; }
                    processed++;
                }

                var pct = Math.round(processed / candidates.length * 100);
                showLoading('检测吞没形态...',
                    processed + '/' + candidates.length + ' (' + pct + '%) ' +
                    '信号' + results.length + '只');

                if (bi + batchSize < candidates.length) await delay(300);
            }

            // ===== 快筛模式：仅今日 + 质量评分 =====
            if (quickMode) {
                var todayResults = [];
                for (var ri2 = 0; ri2 < results.length; ri2++) {
                    if (results[ri2].signal.daysAgo === 0) {
                        todayResults.push(results[ri2]);
                    }
                }
                debugLog('快筛过滤: ' + results.length + ' → 仅今日 ' + todayResults.length + ' 只');

                for (var ri3 = 0; ri3 < todayResults.length; ri3++) {
                    todayResults[ri3].quality = scoreQuality(todayResults[ri3].signal);
                }
                results = todayResults;

                results.sort(function(a, b) {
                    return b.quality.score - a.quality.score;
                });
            } else {
                results.sort(function(a, b) {
                    return b.signal.score - a.signal.score;
                });
            }

            var bearCnt = 0, bullCnt = 0;
            for (var j = 0; j < results.length; j++) {
                if (results[j].signal.direction === 'bearish') bearCnt++;
                else bullCnt++;
            }
            debugLog('=== 扫描完成 ===');
            debugLog('全市场: ' + allStocks.length + ' → 候选: ' + candidates.length +
                ' → 信号: ' + results.length + ' (看跌' + bearCnt + ' 看涨' + bullCnt +
                ' 错误' + errors + ')');

            showResults(results);
            finishRefresh();

        } catch (e) {
            debugLog('!! 异常: ' + (e.message || e));
            showError(e.message || '扫描失败');
            setRefreshButton(false);
            hideLoading();
        } finally {
            // 恢复快筛修改的参数
            if (quickMode) {
                filterDirection = savedDirection;
                quickMode = false;
            }
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

    function showResults(results) {
        var empty = document.getElementById('emptyState');
        if (empty) empty.style.display = 'none';
        var area = document.getElementById('resultArea');
        if (area) area.style.display = 'block';
        var count = document.getElementById('countResult');
        if (count) count.textContent = results.length;
        var badge = document.getElementById('resultBadge');
        if (badge) badge.textContent = quickMode ? '今日触发 · 按质量排序' : '按反转强度排序';

        // 快筛模式：统计各级别数量
        if (quickMode && results.length > 0) {
            var exc = 0, good = 0, warn = 0;
            for (var i = 0; i < results.length; i++) {
                var q = results[i].quality;
                if (q.level === 'excellent') exc++;
                else if (q.level === 'good') good++;
                else warn++;
            }
            var sumEl = document.querySelector('.result-summary');
            if (sumEl) sumEl.innerHTML = '共 <strong>' + results.length + '</strong> 只 · ' +
                '<span style="color:#66BB6A;">🟢优秀 ' + exc + '</span> · ' +
                '<span style="color:#FFD54F;">🟡良好 ' + good + '</span> · ' +
                '<span style="color:#FF6B6B;">🔴警惕 ' + warn + '</span>';
        }

        renderStockCards(results);
    }

    function renderStockCards(stocks) {
        var list = document.getElementById('listResult');
        if (!list) return;

        if (!stocks || stocks.length === 0) {
            list.innerHTML = '<div class="empty-state" style="padding:30px 20px">' +
                '<p class="empty-icon">🔍</p>' +
                '<p class="empty-text">未发现近5日吞没信号</p>' +
                '<p class="empty-hint">可尝试：降低实体幅度要求 / 降低放量倍数 / 降低市值门槛</p>' +
                '</div>';
            return;
        }

        var html = '';
        for (var i = 0; i < stocks.length; i++) {
            var s = stocks[i];
            var sig = s.signal;
            var isBearish = (sig.direction === 'bearish');
            var chgClass = s.change >= 0 ? 'up' : 'down';
            var chgSign = s.change >= 0 ? '+' : '';

            // === 方向相关的颜色和标签 ===
            var dirLabel, dirBgColor, dirAccent, dirScoreColor, dirBadgeBg, dirBadgeColor;
            var bar1Color, bar2Color, bar1StrokeColor, bar2StrokeColor;

            if (isBearish) {
                // 看跌吞没：红色系
                dirLabel = '📉 看跌吞没';
                dirBgColor = '#2D1A1A';
                dirAccent = '#FF6B6B';
                dirScoreColor = '#FF6B6B';
                dirBadgeBg = '#3D1A1A';
                dirBadgeColor = '#FF6B6B';
                bar1Color = '#E74C3C';   // 阳线空心红
                bar2Color = '#66BB6A';   // 阴线实心绿
                bar1StrokeColor = '#E74C3C';
                bar2StrokeColor = '#66BB6A';
            } else {
                // 看涨吞没：绿色系
                dirLabel = '📈 看涨吞没';
                dirBgColor = '#1A2D1A';
                dirAccent = '#66BB6A';
                dirScoreColor = '#66BB6A';
                dirBadgeBg = '#1A3D1A';
                dirBadgeColor = '#66BB6A';
                bar1Color = '#66BB6A';   // 阴线实心绿
                bar2Color = '#E74C3C';   // 阳线实心红
                bar1StrokeColor = '#66BB6A';
                bar2StrokeColor = '#E74C3C';
            }

            // 反转强度等级
            var strengthLabel, strengthClass;
            if (sig.score >= 15) {
                strengthLabel = '强信号';
                strengthClass = 'strong';
            } else if (sig.score >= 8) {
                strengthLabel = '中等';
                strengthClass = 'normal';
            } else {
                strengthLabel = '弱信号';
                strengthClass = 'weak';
            }

            // 距今天数
            var daysAgoTag = '';
            if (sig.daysAgo === 0) {
                daysAgoTag = '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;background:#3D1A1A;color:#FF6B6B;margin-left:6px;">今天</span>';
            } else if (sig.daysAgo === 1) {
                daysAgoTag = '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;background:#3D2E00;color:#FFD54F;margin-left:6px;">昨天</span>';
            } else {
                daysAgoTag = '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;background:#2D3139;color:#AAA;margin-left:6px;">' + sig.daysAgo + '天前</span>';
            }

            // 放量标签
            var volTag = '';
            if (sig.volExpand >= 2.0) {
                volTag = '<span class="vol-expand-tag big">放量' + sig.volExpand.toFixed(1) + 'x</span>';
            } else if (sig.volExpand >= 1.5) {
                volTag = '<span class="vol-expand-tag normal">放量' + sig.volExpand.toFixed(1) + 'x</span>';
            } else {
                volTag = '<span class="vol-expand-tag low">量' + sig.volExpand.toFixed(1) + 'x</span>';
            }

            // === 迷你K线图 ===
            var maxPrice = Math.max(sig.bar2High, sig.bar1High);
            var minPrice = Math.min(sig.bar2Low, sig.bar1Low);
            var priceRange = maxPrice - minPrice || 1;
            var padTop = 8, padBot = 8;
            var chartH = 60, chartW = 140;

            function y(p) {
                return padTop + (maxPrice - p) / priceRange * (chartH - padTop - padBot);
            }

            var svg = '<svg width="' + chartW + '" height="' + chartH + '" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle;">';

            // 前日K线
            var x1 = 10, w1 = 40;
            var o1y = y(sig.bar1Open), c1y = y(sig.bar1Close);
            var h1y = y(sig.bar1High), l1y = y(sig.bar1Low);
            var body1Top = Math.min(o1y, c1y);
            var body1H = Math.abs(c1y - o1y) || 1;

            svg += '<line x1="' + (x1 + w1/2) + '" y1="' + h1y + '" x2="' + (x1 + w1/2) + '" y2="' + body1Top + '" stroke="#AAA" stroke-width="1.5"/>';
            svg += '<line x1="' + (x1 + w1/2) + '" y1="' + (body1Top + body1H) + '" x2="' + (x1 + w1/2) + '" y2="' + l1y + '" stroke="#AAA" stroke-width="1.5"/>';
            if (isBearish) {
                // 阳线：红色空心
                svg += '<rect x="' + x1 + '" y="' + body1Top + '" width="' + w1 + '" height="' + body1H + '" fill="none" stroke="' + bar1StrokeColor + '" stroke-width="2" rx="1"/>';
            } else {
                // 阴线：绿色实心
                svg += '<rect x="' + x1 + '" y="' + body1Top + '" width="' + w1 + '" height="' + body1H + '" fill="' + bar1Color + '" stroke="' + bar1StrokeColor + '" stroke-width="1" rx="1"/>';
            }

            // 后日K线（吞没方）
            var x2 = 90, w2 = 40;
            var o2y = y(sig.bar2Open), c2y = y(sig.bar2Close);
            var h2y = y(sig.bar2High), l2y = y(sig.bar2Low);
            var body2Top = Math.min(o2y, c2y);
            var body2H = Math.abs(c2y - o2y) || 1;

            svg += '<line x1="' + (x2 + w2/2) + '" y1="' + h2y + '" x2="' + (x2 + w2/2) + '" y2="' + body2Top + '" stroke="#AAA" stroke-width="1.5"/>';
            svg += '<line x1="' + (x2 + w2/2) + '" y1="' + (body2Top + body2H) + '" x2="' + (x2 + w2/2) + '" y2="' + l2y + '" stroke="#AAA" stroke-width="1.5"/>';
            if (isBearish) {
                // 阴线：绿色实心
                svg += '<rect x="' + x2 + '" y="' + body2Top + '" width="' + w2 + '" height="' + body2H + '" fill="' + bar2Color + '" stroke="' + bar2StrokeColor + '" stroke-width="1" rx="1"/>';
            } else {
                // 阳线：红色实心
                svg += '<rect x="' + x2 + '" y="' + body2Top + '" width="' + w2 + '" height="' + body2H + '" fill="' + bar2Color + '" stroke="' + bar2StrokeColor + '" stroke-width="1" rx="1"/>';
            }

            // 箭头
            svg += '<line x1="' + (x1 + w1 + 4) + '" y1="' + (chartH/2) + '" x2="' + (x2 - 4) + '" y2="' + (chartH/2) + '" stroke="#888" stroke-width="1" stroke-dasharray="3,2"/>';
            svg += '<polygon points="' + (x2 - 6) + ',' + (chartH/2 - 4) + ' ' + (x2 - 6) + ',' + (chartH/2 + 4) + ' ' + (x2 - 2) + ',' + (chartH/2) + '" fill="#888"/>';

            svg += '</svg>';

            // 前日pct符号
            var bar1Sign = isBearish ? '+' : '-';
            var bar2Sign = isBearish ? '-' : '+';
            var bar1PctColor = isBearish ? '#E74C3C' : '#66BB6A';
            var bar2PctColor = isBearish ? '#66BB6A' : '#E74C3C';

            html += '<div class="stock-card" style="border-left:3px solid ' + dirAccent + ';">' +
                // 头部
                '<div class="stock-card-header">' +
                    '<div><span class="stock-code">' + s.code + '</span>' +
                    '<span class="stock-name">' + s.name + '</span></div>' +
                    '<span class="stock-change ' + chgClass + '">' + chgSign + s.change.toFixed(2) + '%</span>' +
                '</div>' +
                // 方向标签 + 强度
                '<div style="display:flex;align-items:center;gap:10px;margin:8px 0;">' +
                    '<span style="display:inline-block;padding:3px 10px;border-radius:6px;font-size:13px;font-weight:700;background:' + dirBadgeBg + ';color:' + dirBadgeColor + ';">' + dirLabel + '</span>' +
                    '<span style="color:#888;font-size:14px;">强度</span>' +
                    '<span style="font-size:22px;font-weight:800;color:' + dirScoreColor + ';">' + sig.score.toFixed(1) + '</span>' +
                    '<span class="reversal-strength ' + strengthClass + '">' + strengthLabel + '</span>' +
                    daysAgoTag +
                    volTag +
                '</div>' +
                // 快筛模式：质量评分 + 四因子 + 目标价
                (quickMode && s.quality ? (function() {
                    var q = s.quality;
                    var qLabel, qBg, qColor;
                    if (q.level === 'excellent') { qLabel = '🟢 优秀'; qBg = '#1A3D1A'; qColor = '#66BB6A'; }
                    else if (q.level === 'good') { qLabel = '🟡 良好'; qBg = '#3D2E00'; qColor = '#FFD54F'; }
                    else { qLabel = '🔴 警惕'; qBg = '#3D1A1A'; qColor = '#FF6B6B'; }

                    // 四因子标记
                    var factorsHtml = '';
                    for (var fi = 0; fi < q.details.length; fi++) {
                        var f = q.details[fi];
                        var fIcon = f.ok ? '✓' : '✗';
                        var fColor = f.ok ? '#66BB6A' : '#E74C3C';
                        factorsHtml += '<span style="display:inline-block;padding:2px 6px;margin:2px;border-radius:4px;font-size:11px;background:#1A1D23;color:' + fColor + ';">' + fIcon + ' ' + f.name + ' ' + f.value + '</span>';
                    }

                    // 目标卖价
                    var targetPrice = s.price * (1 + q.targetPct / 100);
                    var stopPrice = sig.bar1Low; // 前日最低点

                    return '<div style="margin:6px 0;padding:8px 10px;background:#1A1D23;border-radius:8px;border:1px solid ' + qColor + ';">' +
                        // 质量标签
                        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
                            '<span style="font-size:16px;font-weight:800;color:' + qColor + ';">' + qLabel + '</span>' +
                            '<span style="font-size:12px;color:#888;">四因子 ' + q.score + '/4</span>' +
                        '</div>' +
                        // 四因子
                        '<div style="margin-bottom:8px;">' + factorsHtml + '</div>' +
                        // 目标价 + 止损
                        '<div style="display:flex;gap:16px;font-size:14px;border-top:1px solid #333840;padding-top:6px;">' +
                            '<span>🎯 目标: <b style="color:#66BB6A;">' + targetPrice.toFixed(2) + '</b> <span style="font-size:12px;color:#888;">(+' + q.targetPct.toFixed(1) + '%)</span></span>' +
                            '<span>🛑 止损: <b style="color:#FF6B6B;">' + stopPrice.toFixed(2) + '</b> <span style="font-size:12px;color:#888;">(前低)</span></span>' +
                        '</div>' +
                    '</div>';
                })() : '') +
                // 日期
                '<div style="font-size:13px;color:#888;margin:4px 0;">' +
                    '📅 <span style="color:' + bar1PctColor + ';">' + sig.bar1Label + ' ' + sig.bar1Date + '</span> → ' +
                    '<span style="color:' + bar2PctColor + ';">' + sig.bar2Label + ' ' + sig.bar2Date + '</span>' +
                '</div>' +
                // 迷你图
                '<div style="display:flex;align-items:center;gap:8px;margin:8px 0;padding:8px 0;">' +
                    '<span style="font-size:12px;color:' + bar1PctColor + ';min-width:32px;">' + sig.bar1Label + '</span>' +
                    svg +
                    '<span style="font-size:12px;color:' + bar2PctColor + ';min-width:32px;text-align:right;">' + sig.bar2Label + '</span>' +
                '</div>' +
                // 详情
                '<div class="stock-details">' +
                    '<div class="detail-item"><span class="detail-label">现价</span><span class="detail-value">' + s.price.toFixed(2) + '</span></div>' +
                    '<div class="detail-item"><span class="detail-label">换手率</span><span class="detail-value">' + s.turnover.toFixed(2) + '%</span></div>' +
                    '<div class="detail-item"><span class="detail-label">总市值</span><span class="detail-value">' + s.mktcap.toFixed(0) + '亿</span></div>' +
                '</div>' +
                // 信号详情
                '<div class="reversal-detail">' +
                    '<span class="reversal-item">' + sig.bar1Label + ': <b style="color:' + bar1PctColor + ';">' + bar1Sign + sig.bar1Pct.toFixed(2) + '%</b></span>' +
                    '<span class="reversal-item">' + sig.bar2Label + ': <b style="color:' + bar2PctColor + ';">' + bar2Sign + sig.bar2Pct.toFixed(2) + '%</b></span>' +
                    '<span class="reversal-item">覆盖倍数: <b>' + sig.bodyRatio.toFixed(2) + 'x</b></span>' +
                    '<span class="reversal-item">放量: <b>' + sig.volExpand.toFixed(2) + 'x</b></span>' +
                    '<span class="reversal-item" style="color:#888;font-size:12px;">上穿' + sig.upperPierce.toFixed(1) + '% 下破' + sig.lowerPierce.toFixed(1) + '%</span>' +
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
        var btnQ = document.getElementById('btnQuickScan');
        var btnF = document.getElementById('btnFullScan');
        if (btnQ) { btnQ.disabled = loading; btnQ.textContent = loading ? '⏳ 扫描中...' : '⚡ 2:40 快筛'; }
        if (btnF) { btnF.disabled = loading; btnF.textContent = loading ? '⏳ 扫描中...' : '🔍 全量扫描'; }
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
