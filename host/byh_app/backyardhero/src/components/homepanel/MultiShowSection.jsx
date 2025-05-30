import { useState } from "react";

function explainProtoHandlerStatus(protoHandlerStatus){
    if(protoHandlerStatus == "STANDBY"){
        return "System is in standby - no show is loaded and all receivers are just hanging out."
    }else if(protoHandlerStatus=="LOADING"){
        return "The system is attempting to send all cue timings to the relevant receivers. This shouldnt take long."
    }else if(protoHandlerStatus=="LOADED"){
        return "The system has loaded the show. It is ready to start. You will need to press the big green 'START' on the box."
    }else if(protoHandlerStatus=="START_PENDING"){
        return "The start sequence has started pending a healthcheck and confirmation with receivers that they're ready to rock."
    }else if(protoHandlerStatus=="START_CONFIRMED"){
        return "The receivers have all confirmed 'go'. We are now in a coundown to show start (typically no more than 10 seconds)"
    }else if(protoHandlerStatus=="STARTED"){
        return "The show is currently running. Try to enjoy it.. that's the whole point."
    }else if(protoHandlerStatus=="ABORTED"){
        return "Either by you stopping it, or an error, the show was aborted. It should not be running.. but if things are still exploding.. im sorry."
    }
    return false
}

const MultiShowSection = ({errorsForShow, protoHandlerStatus}) => {
    const [activeTab, setActiveTab] = useState("Show Status");
    const showErrors = errorsForShow


    return (
        <div className="w-full">
            {/* Tab Buttons */}
            <div className="flex border-b border-gray-700">
                {["Show Status", "Check Errors"].map((tab) => (
                    <button
                        key={tab}
                        className={` ml-8 py-2 text-sm font-semibold text-gray-300 transition 
                                    ${activeTab === tab ? "border-b-2 border-green-500 text-white" : "hover:text-gray-100"}`}
                        onClick={() => setActiveTab(tab)}
                    >
                        {tab}
                        {showErrors.length > 0 && tab === "Check Errors" && (
                            <span className="ml-2 bg-red-800 text-white text-xs font-bold rounded-full px-2 py-0.5">
                                {showErrors.length}
                            </span>
                        )}
                    </button>
                ))}
            </div>

            {/* Tab Content */}
            <div className="p-4 bg-gray-900 text-gray-300 rounded-b-lg w-full">
                {activeTab === "Show Status" && <div>
                    {protoHandlerStatus && (
                        <div> {explainProtoHandlerStatus(protoHandlerStatus)} </div>
                    )}
                </div>}
                {activeTab === "Check Errors" && (
                    <ul>
                        {errorsForShow.map((ef)=> {
                            return (<li>{ef}</li>)
                        })}
                    </ul>
                )}
            </div>
        </div>
    );
};

export default MultiShowSection;