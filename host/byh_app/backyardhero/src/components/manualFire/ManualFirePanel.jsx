import { useEffect, useState } from "react";
import axios from "axios";
import useStateAppStore from "@/store/useStateAppStore";
import useAppStore from "@/store/useAppStore";
import { mergeCues } from "../builder/ShowBuilder";


export default function ManualFirePanel(props){
    const fireAddrs = Array.from({ length: 12 }, (_, i) => i + 1);
    const [zone, setZone] = useState(0)
    const [targets, setTargets] = useState([])
    const [devMap, setDevMap] = useState({})
    const { stateData } = useStateAppStore()
    const { systemConfig } = useAppStore()
    const [disabled, setDisabled] = useState(false)
    const [error, setError] = useState(false)

    useEffect(()=>{
        if(!stateData.fw_state?.active_protocol){
            setDisabled(true)
            setError("Cannot manual fire without an active protocol")
        }else if(!stateData.fw_state?.manual_fire_active){
            setDisabled(true)
            setError("Cannot manual fire without manual fire mode active. Turn the key.")
        }else if(systemConfig.receivers){
            console.log(systemConfig.receivers);
            // const tmp_rcv = Object.fromEntries(
            //     Object.entries(systemConfig.receivers).filter(([key, val]) => val.protocol === stateData.fw_state?.active_protocol)
            // )

            setDisabled(false)
            setError(false)
            setDevMap(mergeCues(systemConfig.receivers))
        }else {
            setDisabled(true)
            setError(false)
            setDevMap({})
        }
    },[stateData.fw_state?.active_protocol, stateData.fw_state?.manual_fire_active])

    const fireLocation = async (loc) => {
        console.log(`FIRING Zone: ${zone} TARGET ${loc}`)
        if(stateData.fw_firing?.showId || disabled){
            alert("Firing is disabled. Look at the errors")
        }else{
            const res = await axios.post("/api/system/cmd_daemon", {type: 'manual_fire', data: { target: loc, zone: zone}}, {
                headers: {
                    "Content-Type": "application/json",
                },
            });
        }
    }

    const handleZoneChange = (evt) => {
        setZone(evt.target.value)
        setTargets(devMap[evt.target.value])
    }

    return (
        <div className="flex flex-col justify-center items-center w-full gap-6">
            {/* Show Loaded Message */}
            {stateData.fw_firing?.showId && (
                <div className="w-full max-w-lg bg-red-800 text-white shadow-md rounded px-8 py-6 text-center">
                There is currently a show loaded - you cannot manually fire with a show loaded.
                </div>
            )}

            {disabled && (
                <div className="w-full max-w-lg bg-red-800 text-white shadow-md rounded px-8 py-6 text-center">
                    {error}
                </div>
            )}

            {/* Zone Selector */}
            <div className="flex flex-col items-center justify-center w-full max-w-xs">
                <div className="bg-gray-800 text-white shadow-md rounded-lg px-8 py-6 w-full">
                <label
                    className="block text-gray-200 text-xl font-bold mb-4 text-center"
                    htmlFor="zone"
                >
                    Zone
                </label>
                <select
                    value={zone}
                    onChange={handleZoneChange}
                    name="zone"
                    className="block appearance-none w-full border border-gray-400 hover:border-gray-500 px-4 py-2 pr-8 rounded shadow leading-tight focus:outline-none focus:shadow-outline"
                >
                    {Object.keys(devMap).map((k, i) => (
                    <option key={i} value={k}>
                        {k}
                    </option>
                    ))}
                </select>
                </div>
            </div>

            {/* Fire Buttons Grid */}
            <div className="grid grid-cols-3 gap-6 my-8">
                {targets.map((tgt, i) => (
                <button
                    key={i}
                    onClick={() => fireLocation(tgt)}
                    className="bg-blue-900 hover:bg-blue-700 text-white font-bold py-4 px-6 rounded-lg shadow-md text-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition"
                >
                    {tgt}
                </button>
                ))}
            </div>
            </div>

    )
}