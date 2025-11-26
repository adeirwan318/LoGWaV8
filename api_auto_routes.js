/* api_auto_routes.js - small compatibility routes for AUTO control */
module.exports = function(app, state){
  function expressJsonWrapper(fn){ return function(req,res){ return fn(req,res); }; }

  app.post('/api/auto/start', expressJsonWrapper(async function(req,res){
    try{
      const mode = (req.body && req.body.mode) ? String(req.body.mode).toLowerCase() : 'real';
      if(mode === 'dry'){ state.autoModeDry = true; state.autoModeReal = false; }
      else { state.autoModeReal = true; state.autoModeDry = false; }
      return res.json({ ok:true, mode: state.autoModeReal ? 'real' : 'dry' });
    }catch(e){ return res.status(500).json({ ok:false, error:String(e) }); }
  }));

  app.post('/api/auto/stop', expressJsonWrapper(async function(req,res){
    try{ state.autoModeReal=false; state.autoModeDry=false; return res.json({ ok:true, stopped:true }); }
    catch(e){ return res.status(500).json({ ok:false, error:String(e) }); }
  }));

  app.get('/api/auto/status', function(req,res){
    try{ return res.json({ ok:true, autoReal: !!state.autoModeReal, autoDry: !!state.autoModeDry }); }
    catch(e){ return res.status(500).json({ ok:false, error:String(e) }); }
  });
};
